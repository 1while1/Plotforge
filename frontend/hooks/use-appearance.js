import { useSyncExternalStore } from "react";
import {
	getAppearance,
	setAppearance,
	subscribeAppearance,
} from "../lib/appearance.js";

export function useAppearance() {
	const prefs = useSyncExternalStore(
		subscribeAppearance,
		getAppearance,
		getAppearance,
	);
	return [prefs, setAppearance];
}
