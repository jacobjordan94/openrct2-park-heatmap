import { Sparse } from "./layers";
import { MapScan } from "./mapScan";
import { BaseKind } from "./palette";


/*
 * Guests don't seek out bins: one carrying an empty container only uses a bin if it walks
 * onto a tile with a working one, and otherwise has a small random chance (about every
 * 13 seconds) of dropping it. Broken and ghost bins are ignored (Guest.cpp, FindBin). So what
 * matters is how far guests walk between working bins; benches work the same way.
 */

// Walking distance (tiles) to the nearest working bin beyond which a path tile gets heat.
export const binDistance = 6;
// Walking distance (tiles) to the nearest working bench beyond which a path tile gets heat.
export const benchDistance = 8;
// Heat for path tiles that can't reach any working bin/bench at all.
const unreachableHeat = 10;


const enum AdditionKind {
	Other = 0,
	Bin = 1,
	Bench = 2,
}


// What the scan found on one tile's footpaths.
interface PathTile {
	index: number;
	// Has a non-queue footpath, i.e. guests walk here freely.
	walkable: boolean;
	workingBin: boolean;
	workingBench: boolean;
	broken: number;
}


/**
 * The API doesn't expose a path addition's isBin / isBench flags, so they are recognised by
 * identifier and name. This covers all vanilla objects (rct2.footpath_item.litter*, bench*,
 * rct2tt medbench); custom objects that don't follow the naming won't be recognised.
 */
function additionKind(index: number, cache: { [index: number]: AdditionKind }): AdditionKind {
	const cached = cache[index];
	if (cached !== undefined) {
		return cached;
	}
	let kind = AdditionKind.Other;
	const object = objectManager.getObject("footpath_addition", index);
	if (object) {
		const text = `${object.identifier} ${object.name}`.toLowerCase();
		if (/litter|\bbins?\b/.test(text)) {
			kind = AdditionKind.Bin;
		} else if (/bench|\bseats?\b/.test(text)) {
			kind = AdditionKind.Bench;
		}
	}
	cache[index] = kind;
	return kind;
}


// Reads the footpaths on every tile the base scan saw a path, queue or ride on.
function readPathTiles(scan: MapScan): PathTile[] {
	const { sizeX, sizeY, kinds } = scan;
	const cache: { [index: number]: AdditionKind } = {};
	const result: PathTile[] = [];

	for (let i = 0; i < kinds.length; i++) {
		// Ride tiles are included because a path can run under or over track.
		const kind = kinds[i];
		if (kind !== BaseKind.Path && kind !== BaseKind.Queue && kind !== BaseKind.Ride) {
			continue;
		}
		const x = i % sizeX;
		const y = Math.floor(i / sizeX);
		if (y >= sizeY) {
			break;
		}

		const tile: PathTile = { index: i, walkable: false, workingBin: false, workingBench: false, broken: 0 };
		const elements = map.getTile(x, y).elements;
		for (let e = 0; e < elements.length; e++) {
			const element = elements[e];
			if (element.type !== "footpath") {
				continue;
			}
			if (!element.isQueue) {
				tile.walkable = true;
			}
			if (element.addition === null || element.isAdditionGhost) {
				continue;
			}
			if (element.isAdditionBroken) {
				tile.broken++;
				continue;
			}
			const additionType = additionKind(element.addition, cache);
			if (additionType === AdditionKind.Bin) {
				tile.workingBin = true;
			} else if (additionType === AdditionKind.Bench) {
				tile.workingBench = true;
			}
		}
		if (tile.walkable || tile.broken > 0) {
			result.push(tile);
		}
	}
	return result;
}


// Broken path additions (bins, benches, lamps, ...) per tile.
export function vandalismHeat(scan: MapScan): Sparse {
	const heat: Sparse = {};
	const tiles = readPathTiles(scan);
	for (let i = 0; i < tiles.length; i++) {
		if (tiles[i].broken > 0) {
			heat[tiles[i].index] = tiles[i].broken;
		}
	}
	return heat;
}


/**
 * Heat on walkable path tiles that are more than `limit` tiles of walking from the nearest
 * tile where `isTarget` holds. Uses a breadth-first search over adjacent walkable tiles
 * starting from every target at once. Paths at different heights on neighbouring tiles are
 * treated as connected, which is a close enough approximation for spacing.
 */
export function distanceHeat(scan: MapScan, isTarget: (tile: PathTile) => boolean, limit: number): Sparse {
	const { sizeX } = scan;
	const heat: Sparse = {};
	const tiles = readPathTiles(scan);

	const distance: { [index: number]: number } = {};
	const walkable: { [index: number]: boolean } = {};
	let queue: number[] = [];
	for (let i = 0; i < tiles.length; i++) {
		const tile = tiles[i];
		if (!tile.walkable) {
			continue;
		}
		walkable[tile.index] = true;
		if (isTarget(tile)) {
			distance[tile.index] = 0;
			queue.push(tile.index);
		}
	}

	while (queue.length > 0) {
		const next: number[] = [];
		for (let q = 0; q < queue.length; q++) {
			const index = queue[q];
			const d = distance[index] + 1;
			const x = index % sizeX;
			const neighbours = [
				x > 0 ? index - 1 : -1,
				x < sizeX - 1 ? index + 1 : -1,
				index - sizeX,
				index + sizeX,
			];
			for (let n = 0; n < neighbours.length; n++) {
				const neighbour = neighbours[n];
				if (neighbour >= 0 && walkable[neighbour] && distance[neighbour] === undefined) {
					distance[neighbour] = d;
					next.push(neighbour);
				}
			}
		}
		queue = next;
	}

	for (let i = 0; i < tiles.length; i++) {
		const tile = tiles[i];
		if (!tile.walkable) {
			continue;
		}
		const d = distance[tile.index];
		if (d === undefined) {
			heat[tile.index] = unreachableHeat;
		} else if (d > limit) {
			heat[tile.index] = Math.min(unreachableHeat, d - limit);
		}
	}
	return heat;
}


export function farFromBinHeat(scan: MapScan): Sparse {
	return distanceHeat(scan, tile => tile.workingBin, binDistance);
}


export function farFromBenchHeat(scan: MapScan): Sparse {
	return distanceHeat(scan, tile => tile.workingBench, benchDistance);
}
