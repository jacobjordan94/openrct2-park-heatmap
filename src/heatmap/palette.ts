/**
 * Palette indices (0-255) used for drawing. Values are taken from OpenRCT2's own
 * map window (src/openrct2-ui/windows/Map.cpp) and PaletteIndex.h where possible.
 */

// Base map tile categories, in order of drawing priority (higher wins when tiles are binned).
export const enum BaseKind {
	Outside = 0,
	OwnedLand = 1,
	Water = 2,
	Path = 3,
	Queue = 4,
	Ride = 5,
}

// Palette index per BaseKind.
export const baseColours: number[] = [
	10,  // Outside park: black
	144, // Owned land: dark green
	195, // Water: same as native map window
	17,  // Footpath: same as native map window
	20,  // Queue: lighter grey
	12,  // Ride track / entrance: muted dark grey, so rides are never mistaken for heat
];

// Heat ramp from cool to hot.
export const heatRamp: number[] = [
	136, // dark/light blue
	138, // light blue
	102, // bright green
	54,  // yellow
	183, // orange
	172, // bright red
];

export const transparent = 0;
export const outlineColour = 21; // white: hotspot marker
export const cameraColour = 20;  // light grey: main camera's visible area

// Text colours use the COLOUR_* enum, not palette indices.
export const textWhite = 2;
