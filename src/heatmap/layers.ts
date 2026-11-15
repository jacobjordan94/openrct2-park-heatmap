import { MapScan } from "./mapScan";
import { BaseKind } from "./palette";
import { benchDistance, binDistance, farFromBenchHeat, farFromBinHeat, vandalismHeat } from "./pathLayers";


// Guests below this happiness (0-255) count as unhappy.
const unhappyThreshold = 96;

/*
 * Need thresholds match the points where the game makes guests think about a need
 * (Guest.cpp). Hunger and thirst count down (low = needs it); toilet and nausea count up.
 */
const hungryAtOrBelow = 10;
const thirstyAtOrBelow = 25;
const toiletAtOrAbove = 160;
const sickAtOrAbove = 140;
const verySickAtOrAbove = 200; // The game sends these guests looking for first aid.

// Food and drink items; the game skips hunger and thirst thoughts while a guest carries any.
const foodAndDrink: { [item: string]: boolean } = {
	beef_noodles: true, burger: true, candyfloss: true, chicken: true, chips: true,
	chocolate: true, cookie: true, doughnut: true, hot_dog: true, fried_rice_noodles: true,
	funnel_cake: true, ice_cream: true, meatball_soup: true, pizza: true, popcorn: true,
	pretzel: true, roast_sausage: true, sub_sandwich: true, tentacle: true, toffee_apple: true,
	wonton_soup: true, coffee: true, drink: true, fruit_juice: true, iced_tea: true,
	lemonade: true, soybean_milk: true, sujeonggwa: true,
};

function hasFoodOrDrink(guest: Guest): boolean {
	const items = guest.items;
	for (let i = 0; i < items.length; i++) {
		if (foodAndDrink[items[i].type]) {
			return true;
		}
	}
	return false;
}


// Heat per tile index (`y * sizeX + x`); tiles without heat are absent.
export type Sparse = { [tileIndex: number]: number };


export interface HeatLayer {
	name: string;
	// Describes what one unit of heat means, for the status line.
	unit: string;
	/**
	 * Guest layers: the heat a guest adds to the tile it stands on (0 for none). All guest
	 * layers share a single pass over the guests, which keeps background averaging cheap.
	 */
	guestWeight?: (guest: Guest, tileIndex: number, scan: MapScan) => number;
	// Other layers: computes the heat directly.
	compute?: (scan: MapScan) => Sparse;
	/**
	 * When true, the status line counts tiles with heat rather than summing heat, and skips
	 * the hottest-spot value (used where heat is a distance, not a count of things).
	 */
	countTiles?: boolean;
	/**
	 * When true, the layer shows the state of the map (broken items, path layout) rather than
	 * guest activity. It is never averaged, so changes like a repaired bench show at once.
	 */
	mapState?: boolean;
}


export const layers: HeatLayer[] = [
	{
		name: "Guest crowding",
		unit: "guests walking",
		guestWeight: () => 1,
	},
	{
		name: "Queue crowding",
		unit: "queuing guests",
		guestWeight: (_guest, tileIndex, scan) => scan.kinds[tileIndex] === BaseKind.Queue ? 1 : 0,
	},
	{
		name: "Unhappy guests",
		unit: "unhappy guests",
		guestWeight: guest => guest.happiness < unhappyThreshold ? 1 : 0,
	},
	{
		name: "Hungry guests",
		unit: "hungry guests",
		guestWeight: guest => guest.hunger <= hungryAtOrBelow && !hasFoodOrDrink(guest) ? 1 : 0,
	},
	{
		name: "Thirsty guests",
		unit: "thirsty guests",
		guestWeight: guest => guest.thirst <= thirstyAtOrBelow && !hasFoodOrDrink(guest) ? 1 : 0,
	},
	{
		name: "Need a toilet",
		unit: "guests needing a toilet",
		guestWeight: guest => guest.toilet >= toiletAtOrAbove ? 1 : 0,
	},
	{
		name: "Feeling sick",
		unit: "sick guests (very sick count x2)",
		guestWeight: guest => guest.nausea >= verySickAtOrAbove ? 2 : guest.nausea >= sickAtOrAbove ? 1 : 0,
	},
	{
		name: "Lost guests",
		unit: "lost guests",
		guestWeight: guest => guest.isLost ? 1 : 0,
	},
	{
		name: "Vandalism",
		unit: "broken path items",
		compute: scan => vandalismHeat(scan),
		mapState: true,
	},
	{
		name: "Far from a bin",
		unit: `path tiles over ${binDistance} tiles from a working bin`,
		compute: scan => farFromBinHeat(scan),
		countTiles: true,
		mapState: true,
	},
	{
		name: "Far from a bench",
		unit: `path tiles over ${benchDistance} tiles from a working bench`,
		compute: scan => farFromBenchHeat(scan),
		countTiles: true,
		mapState: true,
	},
	{
		name: "Litter & vomit",
		unit: "litter (vomit counts x2)",
		compute: scan => {
			const heat: Sparse = {};
			const litter = map.getAllEntities("litter");
			for (let i = 0; i < litter.length; i++) {
				const item = litter[i];
				const index = tileIndexAt(scan, item.x, item.y);
				if (index >= 0) {
					const isVomit = (item.litterType === "vomit" || item.litterType === "vomit_alt");
					heat[index] = (heat[index] || 0) + (isVomit ? 2 : 1);
				}
			}
			return heat;
		},
	},
];


// Tile index of a world coordinate (32 units per tile), or -1 if off the map.
function tileIndexAt(scan: MapScan, worldX: number, worldY: number): number {
	const tx = Math.floor(worldX / 32);
	const ty = Math.floor(worldY / 32);
	if (tx < 0 || ty < 0 || tx >= scan.sizeX || ty >= scan.sizeY) {
		return -1; // Includes guests on rides, whose position is off the map.
	}
	return ty * scan.sizeX + tx;
}


/**
 * Computes several layers at once, in the order given. Guest layers share one pass over the
 * guests: each guest's tile is worked out once and every guest layer's weight applied to it.
 */
export function computeLayers(indices: number[], scan: MapScan): Sparse[] {
	const results: Sparse[] = [];
	const guestLayers: number[] = []; // Positions in `indices` of guest layers.
	for (let i = 0; i < indices.length; i++) {
		const layer = layers[indices[i]];
		results.push(layer.compute ? layer.compute(scan) : {});
		if (layer.guestWeight) {
			guestLayers.push(i);
		}
	}
	if (guestLayers.length === 0) {
		return results;
	}

	const guests = map.getAllEntities("guest");
	for (let g = 0; g < guests.length; g++) {
		const guest = guests[g];
		if (!guest.isInPark) {
			continue;
		}
		const index = tileIndexAt(scan, guest.x, guest.y);
		if (index < 0) {
			continue;
		}
		for (let i = 0; i < guestLayers.length; i++) {
			const position = guestLayers[i];
			const weight = layers[indices[position]].guestWeight!(guest, index, scan);
			if (weight) {
				const heat = results[position];
				heat[index] = (heat[index] || 0) + weight;
			}
		}
	}
	return results;
}


export function computeLayer(index: number, scan: MapScan): Sparse {
	return computeLayers([index], scan)[0];
}
