import { startHeatModel } from "./heatmap/heatModel";
import { openHeatmapWindow } from "./heatmap/window";


export function startup() {
	// The heatmap is UI-only, so skip headless servers and the title screen.
	if (typeof ui === "undefined" || context.mode !== "normal") {
		return;
	}

	// Runs in the background so moving averages are already warm when the window opens.
	startHeatModel();
	ui.registerMenuItem("Park Heatmap", () => openHeatmapWindow());
}
