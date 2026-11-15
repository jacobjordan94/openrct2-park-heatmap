import { resetHeatModel } from "./heatmap/heatModel";
import { openHeatmapWindow, toggleHeatmapWindow } from "./heatmap/window";


/**
 * The plugin is intransient: it starts when the game launches and keeps running across park
 * loads. That lets the shortcut be registered on the title screen, so it can be rebound from
 * Options there too. The heatmap itself only works in a played park.
 */
export function startup() {
	// The heatmap is UI-only, so skip headless servers.
	if (typeof ui === "undefined") {
		return;
	}

	ui.registerMenuItem("Park Heatmap", () => openHeatmapWindow());
	// SHIFT+H isn't bound by default in the game; players can rebind it under Options > Controls.
	ui.registerShortcut({
		id: "parkheatmap.toggle",
		text: "Toggle Park Heatmap",
		bindings: ["SHIFT+H"],
		callback: () => toggleHeatmapWindow(),
	});

	// Runs in the background so moving averages are already warm when the window opens.
	// Restarted on every park load, since the plugin outlives each park.
	context.subscribe("map.changed", () => resetHeatModel());
	resetHeatModel();
}
