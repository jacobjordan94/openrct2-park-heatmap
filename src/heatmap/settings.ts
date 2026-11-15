// Heatmap settings, kept in the plugin's shared storage: saved to disk by the game and shared
// across every park, so the window reopens the way it was left.

const prefix = "ParkHeatmap.";


export interface WindowGeometry {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface Settings {
	// The selected layer's name; stored by name so adding or reordering layers keeps it.
	layer: string | null;
	average: boolean;
	geometry: WindowGeometry | null;
}


export function loadSettings(): Settings {
	const storage = context.sharedStorage;
	const layer = storage.get<unknown>(prefix + "layer");
	const average = storage.get<unknown>(prefix + "average");
	const geometry = storage.get<unknown>(prefix + "window");
	return {
		layer: typeof layer === "string" ? layer : null,
		average: average === true,
		geometry: isGeometry(geometry) ? geometry : null,
	};
}


export function saveLayer(name: string): void {
	context.sharedStorage.set(prefix + "layer", name);
}


export function saveAverage(average: boolean): void {
	context.sharedStorage.set(prefix + "average", average);
}


export function saveGeometry(geometry: WindowGeometry): void {
	context.sharedStorage.set(prefix + "window", geometry);
}


function isGeometry(value: unknown): value is WindowGeometry {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const g = value as { [key: string]: unknown };
	return typeof g["x"] === "number" && typeof g["y"] === "number"
		&& typeof g["width"] === "number" && typeof g["height"] === "number";
}
