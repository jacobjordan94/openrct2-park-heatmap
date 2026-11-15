// An inclusive rectangle of tiles that needs rescanning.
export interface TileArea {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

// Either an area to rescan, or "all" when an action has no usable location.
export type MapChange = TileArea | "all";


/**
 * Actions that change what the base map shows (land, water, ownership, paths, rides), with
 * how many tiles around the reported location to rescan. Track pieces get a wide margin
 * because large pieces (loops, helices) reach several tiles from their placement point.
 */
const marginByAction: { [action: string]: number } = {
	footpathplace: 1,
	footpathlayoutplace: 1,
	footpathremove: 1,
	trackplace: 5,
	trackremove: 5,
	mazeplacetrack: 1,
	mazesettrack: 1,
	rideentranceexitplace: 1,
	rideentranceexitremove: 1,
	parkentranceplace: 2,
	parkentranceremove: 2,
	landsetheight: 1,
	landraise: 1,
	landlower: 1,
	landsmooth: 1,
	landbuyrights: 1,
	landsetrights: 1,
	waterraise: 1,
	waterlower: 1,
	watersetheight: 1,
	clearscenery: 1,
	tilemodify: 1,
};

// Actions that can change tiles anywhere, or whose location isn't in their arguments.
const fullRescanActions: { [action: string]: boolean } = {
	ridedemolish: true, // Removes every track piece of a ride.
	trackdesign: true,  // Places a whole ride at once.
	mapchangesize: true,
	cheatset: true,     // Some cheats change land ownership across the map.
};


/**
 * Reports every successful action that changes the base map. Covers actions by all players
 * in multiplayer. Dispose the result to stop watching.
 */
export function watchMapChanges(onChange: (change: MapChange) => void): IDisposable {
	return context.subscribe("action.execute", e => {
		if (e.result && e.result.error) {
			return; // The action failed, so nothing changed.
		}
		const change = changeFor(e);
		if (change) {
			onChange(change);
		}
	});
}


function changeFor(e: GameActionEventArgs): MapChange | null {
	if (fullRescanActions[e.action]) {
		return "all";
	}
	const margin = marginByAction[e.action];
	if (margin === undefined) {
		return null; // Doesn't affect the base map (scenery, prices, staff, ...).
	}

	// Action coordinates are in world units (32 per tile).
	const args = e.args as { [key: string]: unknown };
	const x1 = args["x1"], y1 = args["y1"], x2 = args["x2"], y2 = args["y2"];
	if (typeof x1 === "number" && typeof y1 === "number" && typeof x2 === "number" && typeof y2 === "number") {
		return area(x1, y1, x2, y2, margin);
	}
	const x = args["x"], y = args["y"];
	if (typeof x === "number" && typeof y === "number") {
		return area(x, y, x, y, margin);
	}
	const position = e.result && e.result.position;
	if (position) {
		return area(position.x, position.y, position.x, position.y, margin);
	}
	return "all";
}


function area(worldX1: number, worldY1: number, worldX2: number, worldY2: number, margin: number): TileArea {
	return {
		x1: Math.floor(Math.min(worldX1, worldX2) / 32) - margin,
		y1: Math.floor(Math.min(worldY1, worldY2) / 32) - margin,
		x2: Math.floor(Math.max(worldX1, worldX2) / 32) + margin,
		y2: Math.floor(Math.max(worldY1, worldY2) / 32) + margin,
	};
}
