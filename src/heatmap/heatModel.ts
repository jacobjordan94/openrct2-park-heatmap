import { computeLayers, layers, Sparse } from "./layers";
import { MapScan, rescanArea, scanMap, updateBounds } from "./mapScan";
import { TileArea, watchMapChanges } from "./mapWatcher";


/*
 * The heat model runs for as long as the park is loaded, whether or not the heatmap window
 * is open: it keeps the base map scan current as things are built, and keeps a moving
 * average of every guest-activity layer, so the averages are already warm when viewed.
 */

// How often to sample the averaged layers, in game ticks (40 per second at normal speed).
const sampleTicks = 40;
// Time constant of the moving average, in game ticks: about one minute of game time.
const averageTicks = 60 * 40;
// Averaged values below this fade out to zero, so old trails don't linger forever.
const averageCutoff = 0.01;

let scan: MapScan | null = null;
// Bumped whenever the scan changes, so viewers know to rebuild anything derived from it.
let mapVersion = 0;
let pendingAreas: TileArea[] = [];
let pendingFullRescan = false;

// Layers that are averaged (everything except map-state layers).
const averagedLayers: number[] = [];
for (let i = 0; i < layers.length; i++) {
	if (!layers[i].mapState) {
		averagedLayers.push(i);
	}
}
let averages: { [layerIndex: number]: Sparse } = {};
let lastSampleTick = -1;


let subscribed = false;


/**
 * Starts the model for the park that's loaded now: rescans the map and clears the averages.
 * The plugin is intransient (it runs from game launch, across park loads), so this is called
 * on every park load; its event subscriptions are only made the first time. Outside a played
 * park (title screen, editors) the model stays idle.
 */
export function resetHeatModel(): void {
	if (!subscribed) {
		subscribed = true;
		watchMapChanges(change => {
			if (!scan) {
				return;
			}
			if (change === "all") {
				pendingFullRescan = true;
			} else {
				pendingAreas.push(change);
			}
		});
		context.subscribe("interval.tick", () => {
			if (!scan) {
				// Safety net in case the park-load hook fired before the game mode was updated.
				if (context.mode === "normal") {
					resetHeatModel();
				}
				return;
			}
			applyMapChanges();
			if (date.ticksElapsed % sampleTicks === 0) {
				sample();
			}
		});
	}

	pendingAreas = [];
	pendingFullRescan = false;
	averages = {};
	lastSampleTick = -1;
	scan = (context.mode === "normal") ? scanMap() : null;
	mapVersion++;
	sample();
}


export function getScan(): MapScan | null {
	return scan;
}


export function getMapVersion(): number {
	return mapVersion;
}


// The moving average of a layer, or null for map-state layers and before the first sample.
export function getAverage(layerIndex: number): Sparse | null {
	return averages[layerIndex] || null;
}


/**
 * Rescans the tiles touched by building actions since the last call (or the whole map when
 * an action had no usable location, or the map was resized). Runs every game tick, and is
 * also called by the window each frame so building while paused still shows up.
 */
export function applyMapChanges(): void {
	if (!scan || (!pendingFullRescan && pendingAreas.length === 0)) {
		return;
	}
	if (pendingFullRescan || scan.sizeX !== map.size.x || scan.sizeY !== map.size.y) {
		const resized = scan.sizeX !== map.size.x || scan.sizeY !== map.size.y;
		scan = scanMap();
		if (resized) {
			// Tile indices depend on the map width, so old averages no longer line up.
			averages = {};
			lastSampleTick = -1;
		}
	} else {
		for (let i = 0; i < pendingAreas.length; i++) {
			const a = pendingAreas[i];
			rescanArea(scan, a.x1, a.y1, a.x2, a.y2);
		}
		updateBounds(scan);
	}
	pendingAreas = [];
	pendingFullRescan = false;
	mapVersion++;
}


/**
 * Samples every averaged layer and folds it into its exponential moving average over game
 * time: the weight of each sample depends on the game ticks since the last one, so fast-forward
 * advances the average correctly and paused games (no ticks) leave it unchanged.
 */
function sample(): void {
	if (!scan) {
		return;
	}
	const now = date.ticksElapsed;
	if (now === lastSampleTick) {
		return;
	}
	const alpha = lastSampleTick < 0 ? 1 : 1 - Math.exp(-(now - lastSampleTick) / averageTicks);
	lastSampleTick = now;

	const snapshots = computeLayers(averagedLayers, scan);
	for (let i = 0; i < averagedLayers.length; i++) {
		const layerIndex = averagedLayers[i];
		const average = averages[layerIndex];
		if (!average || alpha === 1) {
			averages[layerIndex] = copy(snapshots[i]);
		} else {
			updateAverage(average, snapshots[i], alpha);
		}
	}
}


function copy(heat: Sparse): Sparse {
	const result: Sparse = {};
	for (const key in heat) {
		result[+key] = heat[+key];
	}
	return result;
}


// average += (snapshot - average) * alpha, over the union of both sets of tiles.
function updateAverage(average: Sparse, snapshot: Sparse, alpha: number): void {
	const seen: { [tileIndex: number]: boolean } = {};
	for (const key in average) {
		const index = +key;
		seen[index] = true;
		const value = average[index] + ((snapshot[index] || 0) - average[index]) * alpha;
		if (value < averageCutoff) {
			delete average[index];
		} else {
			average[index] = value;
		}
	}
	for (const key in snapshot) {
		const index = +key;
		if (seen[index]) {
			continue;
		}
		const value = snapshot[index] * alpha;
		if (value >= averageCutoff) {
			average[index] = value;
		}
	}
}
