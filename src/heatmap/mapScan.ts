import { BaseKind } from "./palette";


export interface MapScan {
	sizeX: number;
	sizeY: number;
	// BaseKind per tile, indexed by `y * sizeX + x`.
	kinds: number[];
	// Tile bounds of the park (owned land, paths, rides) with a small margin; the whole map if none.
	bounds: Bounds;
}

export interface Bounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

// Empty tiles of map around the park, so its edges are not flush with the window border.
const boundsMargin = 3;


/**
 * Scans every tile once to build the static base map (land, water, paths, queues, rides).
 * This is relatively expensive on large maps; after building, use rescanArea instead.
 */
export function scanMap(): MapScan {
	const sizeX = map.size.x;
	const sizeY = map.size.y;
	const kinds: number[] = new Array(sizeX * sizeY);
	for (let y = 0; y < sizeY; y++) {
		for (let x = 0; x < sizeX; x++) {
			kinds[y * sizeX + x] = classifyTile(map.getTile(x, y));
		}
	}
	return { sizeX, sizeY, kinds, bounds: computeBounds(sizeX, sizeY, kinds) };
}


// Re-reads an inclusive rectangle of tiles (clamped to the map). Call updateBounds afterwards.
export function rescanArea(scan: MapScan, x1: number, y1: number, x2: number, y2: number): void {
	const { sizeX, sizeY, kinds } = scan;
	const fromX = Math.max(0, x1), toX = Math.min(sizeX - 1, x2);
	const fromY = Math.max(0, y1), toY = Math.min(sizeY - 1, y2);
	for (let y = fromY; y <= toY; y++) {
		for (let x = fromX; x <= toX; x++) {
			kinds[y * sizeX + x] = classifyTile(map.getTile(x, y));
		}
	}
}


// Recomputes the park bounds after one or more rescanArea calls.
export function updateBounds(scan: MapScan): void {
	scan.bounds = computeBounds(scan.sizeX, scan.sizeY, scan.kinds);
}


// Bounds of owned land, paths and rides, plus a margin. Cheap: it only reads the kinds array.
function computeBounds(sizeX: number, sizeY: number, kinds: number[]): Bounds {
	let minX = sizeX, minY = sizeY, maxX = -1, maxY = -1;
	for (let y = 0; y < sizeY; y++) {
		for (let x = 0; x < sizeX; x++) {
			const kind = kinds[y * sizeX + x];
			// Water is excluded so lakes outside the park don't widen the view.
			if (kind !== BaseKind.Outside && kind !== BaseKind.Water) {
				if (x < minX) {
					minX = x;
				}
				if (x > maxX) {
					maxX = x;
				}
				if (y < minY) {
					minY = y;
				}
				if (y > maxY) {
					maxY = y;
				}
			}
		}
	}
	return (maxX < 0)
		? { minX: 0, minY: 0, maxX: sizeX - 1, maxY: sizeY - 1 }
		: {
			minX: Math.max(0, minX - boundsMargin),
			minY: Math.max(0, minY - boundsMargin),
			maxX: Math.min(sizeX - 1, maxX + boundsMargin),
			maxY: Math.min(sizeY - 1, maxY + boundsMargin),
		};
}


function classifyTile(tile: Tile): BaseKind {
	let kind = BaseKind.Outside;
	const elements = tile.elements;

	for (let i = 0; i < elements.length; i++) {
		const element = elements[i];
		let found = BaseKind.Outside;

		switch (element.type) {
			case "surface":
				if (element.waterHeight > element.baseZ) {
					found = BaseKind.Water;
				} else if (element.hasOwnership) {
					found = BaseKind.OwnedLand;
				}
				break;
			case "footpath":
				found = element.isQueue ? BaseKind.Queue : BaseKind.Path;
				break;
			case "track":
			case "entrance":
				found = BaseKind.Ride;
				break;
		}
		if (found > kind) {
			kind = found;
		}
	}
	return kind;
}
