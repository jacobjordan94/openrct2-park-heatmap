import { applyMapChanges, getAverage, getMapVersion, getScan } from "./heatModel";
import { computeLayer, HeatLayer, layers, Sparse } from "./layers";
import { MapScan } from "./mapScan";
import { loadSettings, saveAverage, saveGeometry, saveLayer, WindowGeometry } from "./settings";
import { baseColours, cameraColour, heatRamp, outlineColour, textWhite, transparent } from "./palette";


const classification = "park-heatmap";
const refreshTicks = 40; // ~1 second
const legendHeight = 14;
// The game only starts a resize from a click on the window background within 19px of the bottom-right corner.
const resizeGrip = 19;
// Space below the map for the legend; the legend stops short of the resize grip.
const bottomStrip = legendHeight + 8;
const maxHotspots = 10;

const margin = 5;
const optionsTop = 34;
const statusTop = 48;
const mapTop = 63;

function mapHeightFor(windowHeight: number): number { return windowHeight - mapTop - bottomStrip; }
function legendYFor(windowHeight: number): number { return windowHeight - legendHeight - 4; }
function legendWidthFor(windowWidth: number): number { return windowWidth - margin - resizeGrip - 5; }

const defaultWidth = 280;
const defaultHeight = 343;
const minWindowWidth = 240;
const minWindowHeight = 200;
const maxWindowWidth = 1200;
const maxWindowHeight = 1000;
// Window size and position are saved once they've been unchanged this many frames (~1 second),
// so dragging or resizing doesn't write to disk every frame.
const geometrySaveDelay = 40;
// How much of the title bar must stay on screen when restoring, so the window can be dragged back.
const titleBarHeight = 15;
const reachableEdge = 40;
const rowGap = 2;

/**
 * Splits the top row (layer dropdown, hotspot button) across the window width, so the
 * controls always stay inside the window: anything outside its frame is never repainted.
 */
function topRowFor(windowWidth: number): { dropdownWidth: number, buttonWidth: number, hotspotX: number } {
	const avail = windowWidth - margin * 2 - rowGap;
	const buttonWidth = Math.floor(avail * 0.4);
	const dropdownWidth = avail - buttonWidth;
	return { dropdownWidth, buttonWidth, hotspotX: margin + dropdownWidth + rowGap };
}

// The game's zoom range: -2 is the closest, 3 the furthest out.
const minZoom = -2;
const maxZoom = 3;

/**
 * Detail at the game's closest zoom, in `k` per tile (a tile is drawn 4k pixels wide).
 * At the furthest zoom the whole park fits; the zoom levels in between are spread evenly.
 */
const maxTileK = 4;


// The park's bounding box binned into cells of `block` x `block` tiles.
interface Bin {
	block: number;
	cols: number;
	rows: number;
	base: number[];
	heat: number[];
	max: number;
}

/**
 * Where and how big the cells are drawn. Cells are drawn isometrically, like the game's own
 * map window, so the map matches the camera rotation: each cell is a `2k` x `2k` square and
 * neighbouring columns are offset by `k` pixels, which tiles into a diamond with no gaps.
 * `k` may be fractional; cell edges are rounded from shared positions so they still meet.
 */
interface Layout {
	bin: Bin;
	k: number;
	ox: number;
	oy: number;
	rotation: number;
	// True when the whole park is shown; false when zoomed in around the camera.
	fitted: boolean;
}

// A hotspot's center, in tile coordinates.
interface Hotspot {
	x: number;
	y: number;
}


// The heat model's scan; the model keeps it current as things are built.
let scan: MapScan | null = null;
let lastMapVersion = -1;
// The heat being displayed: either the live snapshot or the model's moving average.
let tileHeat: Sparse = {};
let snapshotHeat: Sparse = {};
let showAverage = false;
let bins: { [block: number]: Bin } = {};
let layerIndex = 0;
let hotspots: Hotspot[] = [];
let hotspotIndex = -1;
let fitMax = 0;
let ticks = 0;
let lastWidth = 0;
let lastHeight = 0;
let lastRotation = -1;
let lastZoom = 0;
// Main viewport's view rectangle when last drawn, to redraw the camera outline when it moves.
let lastView = "";
// The window's geometry as last seen, and the frame it last changed (-1 when already saved).
let geometry: WindowGeometry | null = null;
let geometryChangedAt = -1;


// Closes the window if it's open, otherwise opens it (for the keyboard shortcut).
export function toggleHeatmapWindow(): void {
	const existing = ui.getWindow(classification);
	if (existing) {
		existing.close();
	} else {
		openHeatmapWindow();
	}
}


export function openHeatmapWindow(): void {
	if (!getScan()) {
		return; // Not in a played park (title screen or an editor).
	}
	const existing = ui.getWindow(classification);
	if (existing) {
		existing.bringToFront();
		return;
	}

	// Restore the last layer, averaging choice, size and position.
	const settings = loadSettings();
	for (let i = 0; i < layers.length; i++) {
		if (layers[i].name === settings.layer) {
			layerIndex = i;
		}
	}
	showAverage = settings.average;
	const saved = settings.geometry;
	const width = clamp(saved ? saved.width : defaultWidth, minWindowWidth, maxWindowWidth);
	const height = clamp(saved ? saved.height : defaultHeight, minWindowHeight, maxWindowHeight);
	// Restore the position as left, even partly off-screen like the game allows; only pull it
	// back if the title bar would be out of reach (e.g. the resolution shrank since saving).
	const position = saved
		? {
			x: clamp(saved.x, reachableEdge - width, ui.width - reachableEdge),
			y: clamp(saved.y, 0, ui.height - titleBarHeight),
		}
		: undefined;

	const row = topRowFor(width);
	lastWidth = width;
	lastHeight = height;
	geometry = null;
	geometryChangedAt = -1;
	scan = getScan();
	lastMapVersion = getMapVersion();
	hotspotIndex = -1;
	refreshHeat();

	ui.openWindow({
		classification,
		title: "Park Heatmap",
		x: position ? position.x : undefined,
		y: position ? position.y : undefined,
		width, height,
		minWidth: minWindowWidth, minHeight: minWindowHeight,
		maxWidth: maxWindowWidth, maxHeight: maxWindowHeight,
		widgets: [
			{
				type: "dropdown", name: "layer",
				x: margin, y: 18, width: row.dropdownWidth, height: 14,
				items: layers.map(l => l.name),
				selectedIndex: layerIndex,
				onChange: index => {
					layerIndex = index;
					saveLayer(layers[index].name);
					hotspotIndex = -1;
					const window = ui.getWindow(classification);
					if (window) {
						// Map-state layers are never averaged.
						window.findWidget<CheckboxWidget>("average").isDisabled = !!currentLayer().mapState;
					}
					refreshHeat();
					redraw();
				},
			},
			{
				type: "button", name: "hotspot",
				x: row.hotspotX, y: 18, width: row.buttonWidth, height: 14,
				text: "Next hotspot",
				tooltip: "Move the camera to the next hottest spot",
				onClick: () => gotoNextHotspot(),
			},
			{
				type: "checkbox", name: "average",
				x: margin, y: optionsTop, width: width - margin * 2, height: 12,
				text: "Average over 1 minute",
				tooltip: "Show a moving average of the last minute of game time instead of a live snapshot",
				isChecked: showAverage,
				isDisabled: !!currentLayer().mapState,
				onChange: checked => {
					showAverage = checked;
					saveAverage(checked);
					hotspotIndex = -1;
					selectDisplayedHeat();
					redraw();
				},
			},
			{
				type: "label", name: "status",
				x: margin, y: statusTop, width: width - margin * 2, height: 12,
				text: statusText(),
			},
			{
				type: "custom", name: "map",
				// Custom widgets act as buttons (click sound, pressed state, repaint); disabling
				// makes them display-only. They are still drawn.
				isDisabled: true,
				x: margin, y: mapTop, width: width - margin * 2, height: mapHeightFor(height),
				onDraw: function (g) { drawMap(g, this.width, this.height); },
			},
			{
				type: "custom", name: "legend",
				// Custom widgets act as buttons (click sound, pressed state, repaint); disabling
				// makes them display-only. They are still drawn.
				isDisabled: true,
				x: margin, y: legendYFor(height), width: legendWidthFor(width), height: legendHeight,
				onDraw: function (g) { drawLegend(g, this.width, this.height); },
			},
		],
		onUpdate: () => onUpdate(),
		onClose: () => {
			if (geometry && geometryChangedAt >= 0) {
				saveGeometry(geometry); // Moved or resized just before closing.
			}
			scan = null;
			bins = {};
			tileHeat = {};
			snapshotHeat = {};
		},
	});
}


function onUpdate(): void {
	const window = ui.getWindow(classification);
	if (!window) {
		return;
	}
	let dirty = false;

	// Keep widgets fitted to the window when it is resized.
	if (window.width !== lastWidth || window.height !== lastHeight) {
		lastWidth = window.width;
		lastHeight = window.height;
		const mapWidget = window.findWidget<CustomWidget>("map");
		mapWidget.width = window.width - margin * 2;
		mapWidget.height = mapHeightFor(window.height);
		const legendWidget = window.findWidget<CustomWidget>("legend");
		legendWidget.y = legendYFor(window.height);
		legendWidget.width = legendWidthFor(window.width);
		window.findWidget<LabelWidget>("status").width = window.width - margin * 2;
		window.findWidget<CheckboxWidget>("average").width = window.width - margin * 2;
		const row = topRowFor(window.width);
		window.findWidget<DropdownWidget>("layer").width = row.dropdownWidth;
		const hotspotButton = window.findWidget<ButtonWidget>("hotspot");
		hotspotButton.x = row.hotspotX;
		hotspotButton.width = row.buttonWidth;
		hotspots = []; // Hotspot grouping depends on the fitted block size.
		dirty = true;
	}

	// Follow the main camera's rotation and zoom immediately, and its position when zoomed in.
	const viewport = ui.mainViewport;
	if (viewport.rotation !== lastRotation || viewport.zoom !== lastZoom) {
		lastRotation = viewport.rotation;
		lastZoom = viewport.zoom;
		dirty = true;
	}
	if (viewKey(viewport) !== lastView) {
		dirty = true; // The camera moved or the game window was resized.
	}

	// Apply building done this frame (game ticks don't run while paused), then pick up any
	// change the model made to the scan.
	applyMapChanges();
	if (getMapVersion() !== lastMapVersion) {
		lastMapVersion = getMapVersion();
		scan = getScan();
		refreshHeat(); // Also drops cached bins and hotspots, which depend on the park bounds.
		dirty = true;
	}

	ticks++;
	trackGeometry(window);
	if (ticks % refreshTicks === 0) {
		refreshHeat();
		dirty = true;
	}
	if (dirty) {
		redraw();
	}
}


// Saves the window's size and position once they've settled after a move or resize.
function trackGeometry(window: Window): void {
	const current = { x: window.x, y: window.y, width: window.width, height: window.height };
	if (!geometry || current.x !== geometry.x || current.y !== geometry.y
		|| current.width !== geometry.width || current.height !== geometry.height) {
		// The first frame only records the starting geometry; later changes need saving.
		geometryChangedAt = geometry ? ticks : -1;
		geometry = current;
	} else if (geometryChangedAt >= 0 && ticks - geometryChangedAt >= geometrySaveDelay) {
		saveGeometry(geometry);
		geometryChangedAt = -1;
	}
}


function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}


function currentLayer(): HeatLayer {
	return layers[layerIndex];
}


/**
 * Takes a new live snapshot of the current layer. The moving average is kept by the heat
 * model in the background, so it only needs to be read.
 */
function refreshHeat(): void {
	if (!scan) {
		return;
	}
	snapshotHeat = computeLayer(layerIndex, scan);
	selectDisplayedHeat();
}


// Points the display at the snapshot or the average, and drops cached bins and hotspots.
function selectDisplayedHeat(): void {
	const average = isAveraging() ? getAverage(layerIndex) : null;
	tileHeat = average || snapshotHeat;
	bins = {};
	hotspots = [];
}


// Whether the displayed heat is the moving average (never for map-state layers).
function isAveraging(): boolean {
	return showAverage && !currentLayer().mapState;
}


// Whole numbers stay whole; averaged values get one decimal when small.
function formatHeat(value: number): string {
	if (value > 0 && value < 0.1) {
		return "<0.1"; // Fading averages; "0.0" would contradict the coloured tiles.
	}
	return (value >= 10 || value === Math.floor(value)) ? `${Math.round(value)}` : value.toFixed(1);
}


// Forces the custom widget and status label to redraw.
function redraw(): void {
	const window = ui.getWindow(classification);
	if (!window) {
		return;
	}
	ensureHotspots();
	window.findWidget<LabelWidget>("status").text = statusText();
	const mapWidget = window.findWidget<CustomWidget>("map");
	mapWidget.x = mapWidget.x; // Setting a position invalidates the widget.
}


// Bins the park's bounding box into `block` x `block` cells (cached until the heat refreshes).
function getBin(block: number): Bin | null {
	if (!scan) {
		return null;
	}
	const cached = bins[block];
	if (cached) {
		return cached;
	}

	const { kinds, bounds } = scan;
	const mapWidth = scan.sizeX;
	const sizeX = bounds.maxX - bounds.minX + 1;
	const sizeY = bounds.maxY - bounds.minY + 1;
	const cols = Math.ceil(sizeX / block);
	const rows = Math.ceil(sizeY / block);

	const base: number[] = new Array(cols * rows);
	const heat: number[] = new Array(cols * rows);
	for (let i = 0; i < base.length; i++) {
		base[i] = 0;
		heat[i] = 0;
	}

	for (let y = 0; y < sizeY; y++) {
		const row = Math.floor(y / block) * cols;
		for (let x = 0; x < sizeX; x++) {
			const tile = (y + bounds.minY) * mapWidth + (x + bounds.minX);
			const cell = row + Math.floor(x / block);
			if (kinds[tile] > base[cell]) {
				base[cell] = kinds[tile];
			}
			const tileValue = tileHeat[tile];
			if (tileValue) {
				heat[cell] += tileValue;
			}
		}
	}

	let max = 0;
	for (let i = 0; i < heat.length; i++) {
		if (heat[i] > max) {
			max = heat[i];
		}
	}

	const bin: Bin = { block, cols, rows, base, heat, max };
	bins[block] = bin;
	return bin;
}


/**
 * The `k` per tile at which the whole park fits. The diamond is about (sizeX + sizeY) * 2k
 * wide and (sizeX + sizeY) * k tall regardless of rotation; the +2 leaves room for rounding
 * up to whole cells when binning.
 */
function fitTileK(availW: number, availH: number): number {
	const b = scan!.bounds;
	const span = (b.maxX - b.minX + 1) + (b.maxY - b.minY + 1) + 2;
	return Math.min(availW / (span * 2), availH / span);
}


// Smallest block size whose cells are at least 2x2 pixels at the given k per tile.
function blockFor(tileK: number): number {
	return Math.max(1, Math.ceil(1 / tileK));
}


function getLayout(width: number, height: number): Layout | null {
	if (!scan) {
		return null;
	}
	const availW = Math.max(1, width);
	const availH = Math.max(1, height);
	const viewport = ui.mainViewport;
	const rotation = viewport.rotation;

	// Spread the game's zoom levels evenly (geometrically) from "whole park" to full detail.
	const fitK = fitTileK(availW, availH);
	const zoom = Math.max(minZoom, Math.min(maxZoom, viewport.zoom));
	const t = (maxZoom - zoom) / (maxZoom - minZoom);
	const tileK = (fitK >= maxTileK) ? fitK : fitK * Math.pow(maxTileK / fitK, t);

	const block = blockFor(tileK);
	const bin = getBin(block)!;
	const layout: Layout = { bin, k: tileK * block, rotation, fitted: t === 0, ox: 0, oy: 0 };

	if (layout.fitted) {
		// center the whole park.
		layout.ox = (availW - (bin.cols + bin.rows - 1) * 2 * layout.k) / 2;
		layout.oy = (availH - (bin.cols + bin.rows) * layout.k) / 2;
	} else {
		// center the camera's focus point.
		const center = cameraFocus(viewport);
		const focus = tileToScreen(layout, center.x / 32, center.y / 32);
		layout.ox = availW / 2 - focus.x;
		layout.oy = availH / 2 - focus.y;
	}
	return layout;
}


/**
 * Returns a cell's position in units of k (cx/cy may be fractional). Mirrors OpenRCT2's
 * Translate3DTo2D: for each camera rotation, cell coordinates are remapped to (rx, ry) so
 * that screen x follows (ry - rx) and screen y follows (rx + ry).
 */
function cellUnits(l: Layout, cx: number, cy: number): { u: number, v: number } {
	const { cols, rows } = l.bin;
	let rx: number, ry: number, rotatedCols: number;
	switch (l.rotation & 3) {
		case 1: rx = cy; ry = cols - 1 - cx; rotatedCols = rows; break;
		case 2: rx = cols - 1 - cx; ry = rows - 1 - cy; rotatedCols = cols; break;
		case 3: rx = rows - 1 - cy; ry = cx; rotatedCols = rows; break;
		default: rx = cx; ry = cy; rotatedCols = cols; break;
	}
	return { u: (ry - rx + rotatedCols - 1) * 2, v: rx + ry };
}


// Returns the pixel at the center of a (fractional) map tile position.
function tileToScreen(l: Layout, tileX: number, tileY: number): { x: number, y: number } {
	const b = scan!.bounds;
	const block = l.bin.block;
	const p = cellUnits(l, (tileX - b.minX) / block - 0.5, (tileY - b.minY) / block - 0.5);
	return { x: l.ox + (p.u + 1) * l.k, y: l.oy + (p.v + 1) * l.k };
}


// Finds the hottest areas at the "whole park" block size, so they don't change with zoom.
function ensureHotspots(): void {
	if (!scan || hotspots.length > 0) {
		return;
	}
	const fitK = fitTileK(Math.max(1, lastWidth - margin * 2), Math.max(1, mapHeightFor(lastHeight)));
	const bin = getBin(blockFor(fitK))!;
	fitMax = bin.max;

	const cells: number[] = [];
	for (let i = 0; i < bin.heat.length; i++) {
		if (bin.heat[i] > 0) {
			cells.push(i);
		}
	}
	cells.sort((a, b) => bin.heat[b] - bin.heat[a]);

	const b = scan.bounds;
	hotspots = cells.slice(0, maxHotspots).map(cell => ({
		x: b.minX + ((cell % bin.cols) + 0.5) * bin.block,
		y: b.minY + (Math.floor(cell / bin.cols) + 0.5) * bin.block,
	}));
	if (hotspotIndex >= hotspots.length) {
		hotspotIndex = -1;
	}
}


function gotoNextHotspot(): void {
	ensureHotspots();
	if (hotspots.length === 0) {
		ui.showError("Park Heatmap", "No hotspots for this layer right now.");
		return;
	}
	hotspotIndex = (hotspotIndex + 1) % hotspots.length;
	const spot = hotspots[hotspotIndex];
	ui.mainViewport.scrollTo({ x: spot.x * 32, y: spot.y * 32 });
	redraw();
}


function statusText(): string {
	const layer = currentLayer();
	let total = 0;
	for (const key in tileHeat) {
		const value = tileHeat[+key];
		total += layer.countTiles ? (value > 0 ? 1 : 0) : value;
	}
	let text = `${formatHeat(total)} ${layer.unit}`;
	if (isAveraging()) {
		text = `avg ${text}`;
	}
	if (fitMax > 0 && !layer.countTiles) {
		text += `, hottest spot: ${formatHeat(fitMax)}`;
	}
	if (hotspotIndex >= 0) {
		text += ` (viewing #${hotspotIndex + 1})`;
	}
	return text;
}


function heatLevel(value: number, max: number): number {
	// Square root scaling keeps quieter areas visible next to one very busy spot.
	const level = Math.ceil(Math.sqrt(value / max) * heatRamp.length) - 1;
	return Math.max(0, Math.min(heatRamp.length - 1, level));
}


function drawMap(g: GraphicsContext, width: number, height: number): void {
	g.stroke = transparent;
	g.fill = baseColours[0];
	g.rect(0, 0, width, height);

	const layout = getLayout(width, height);
	if (!layout) {
		return;
	}
	lastView = viewKey(ui.mainViewport);

	const { bin, k, ox, oy } = layout;
	const { cols, rows, base, heat, max } = bin;
	const mapHeight = height;

	for (let cy = 0; cy < rows; cy++) {
		for (let cx = 0; cx < cols; cx++) {
			const i = cy * cols + cx;
			let colour = baseColours[base[i]];
			if (heat[i] > 0 && max > 0) {
				colour = heatRamp[heatLevel(heat[i], max)];
			} else if (base[i] === 0) {
				continue; // Already the background colour.
			}

			// Edges come from shared unit positions, so neighbouring cells always meet exactly.
			const p = cellUnits(layout, cx, cy);
			const x0 = Math.floor(ox + p.u * k);
			const x1 = Math.floor(ox + (p.u + 2) * k);
			const y0 = Math.floor(oy + p.v * k);
			const y1 = Math.min(mapHeight, Math.floor(oy + (p.v + 2) * k));
			if (x1 <= 0 || y1 <= 0 || x0 >= width || y0 >= mapHeight) {
				continue; // Off-screen when zoomed in.
			}
			g.fill = colour;
			g.rect(x0, y0, x1 - x0, y1 - y0);
		}
	}

	drawCameraOutline(g, layout);

	// Outline the hotspot the camera was last sent to.
	if (hotspotIndex >= 0 && hotspotIndex < hotspots.length) {
		const spot = hotspots[hotspotIndex];
		const p = tileToScreen(layout, spot.x, spot.y);
		const box = Math.max(Math.round(k * 2) + 6, 8);
		drawOutline(g, Math.round(p.x - box / 2), Math.round(p.y - box / 2), box, box, outlineColour);
	}
}


/**
 * Note: always size drawing from the widget, never from g.width/g.height. Those are the
 * render target's size, which is clipped to whatever part of the window is being repainted.
 */
/**
 * The ground point at the center of the main view, in world coordinates. Viewport's own
 * getcenterPosition() assumes a fixed height (z = 24), which lands off-target on hilly
 * terrain. Like the game's own screen-to-map lookup, this alternates between projecting at
 * a height and reading the ground height there until it settles.
 */
function cameraFocus(viewport: Viewport): CoordsXY {
	const sx = (viewport.left + viewport.right) / 2;
	const sy = (viewport.top + viewport.bottom) / 2;
	let z = 0;
	let pos = viewToMap(sx, sy, z, viewport.rotation);
	for (let i = 0; i < 5; i++) {
		const ground = groundZ(pos.x, pos.y);
		if (ground === z) {
			break;
		}
		z = ground;
		pos = viewToMap(sx, sy, z, viewport.rotation);
	}
	return pos;
}


// Inverse of the game's Translate3DTo2D for each rotation, at world height z.
function viewToMap(sx: number, sy: number, z: number, rotation: number): CoordsXY {
	const h = 2 * (sy + z);
	switch (rotation & 3) {
		case 1: return { x: (-sx - h) / 2, y: (-sx + h) / 2 };  // sx = -x - y, h = y - x
		case 2: return { x: (-h + sx) / 2, y: (-h - sx) / 2 };  // sx = x - y,  h = -x - y
		case 3: return { x: (sx + h) / 2, y: (sx - h) / 2 };    // sx = x + y,  h = x - y
		default: return { x: (h - sx) / 2, y: (h + sx) / 2 };   // sx = y - x,  h = x + y
	}
}


// Height of the land (or water surface) at a world position; 0 off the map.
function groundZ(worldX: number, worldY: number): number {
	const tx = Math.floor(worldX / 32);
	const ty = Math.floor(worldY / 32);
	if (tx < 0 || ty < 0 || tx >= map.size.x || ty >= map.size.y) {
		return 0;
	}
	const elements = map.getTile(tx, ty).elements;
	for (let i = 0; i < elements.length; i++) {
		const element = elements[i];
		if (element.type === "surface") {
			return Math.max(element.baseZ, element.waterHeight);
		}
	}
	return 0;
}


function viewKey(viewport: Viewport): string {
	return `${viewport.left},${viewport.top},${viewport.right},${viewport.bottom}`;
}


/**
 * Outlines the area the main camera shows. The game's view uses the same isometric
 * projection as this map (view x = 32 units per tile step, view y = 16), so its screen
 * rectangle maps to a rectangle here: centerd on the camera's focus point and scaled by
 * k / block pixels per 16 view units on both axes.
 */
function drawCameraOutline(g: GraphicsContext, layout: Layout): void {
	const viewport = ui.mainViewport;
	const center = cameraFocus(viewport);
	const p = tileToScreen(layout, center.x / 32, center.y / 32);
	const scale = layout.k / layout.bin.block / 16;
	const w = Math.max(4, Math.round((viewport.right - viewport.left) * scale));
	const h = Math.max(4, Math.round((viewport.bottom - viewport.top) * scale));

	drawOutline(g, Math.round(p.x - w / 2), Math.round(p.y - h / 2), w, h, cameraColour);
}


/**
 * Draws a 1px rectangle outline from four filled strips. The graphics context's stroked
 * rect() is built from Bresenham lines whose top and bottom edges overshoot by a pixel and
 * whose corners don't always meet; fills are pixel-exact.
 */
function drawOutline(g: GraphicsContext, x: number, y: number, w: number, h: number, colour: number): void {
	g.stroke = transparent;
	g.fill = colour;
	g.rect(x, y, w, 1);         // top
	g.rect(x, y + h - 1, w, 1); // bottom
	g.rect(x, y, 1, h);         // left
	g.rect(x + w - 1, y, 1, h); // right
}


function drawLegend(g: GraphicsContext, width: number, height: number): void {
	const y = 2;
	g.stroke = transparent;
	g.fill = baseColours[0];
	g.rect(0, 0, width, height);

	g.colour = textWhite;
	g.text("Low", 2, y);
	const start = 2 + g.measureText("Low ").width;
	for (let i = 0; i < heatRamp.length; i++) {
		g.fill = heatRamp[i];
		g.rect(start + i * 12, y + 1, 10, 8);
	}
	g.text("High", start + heatRamp.length * 12 + 3, y);
}
