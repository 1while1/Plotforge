import { useSyncExternalStore } from "react";
import {
	getWritingPrefs,
	subscribeWritingPrefs,
} from "../lib/writing-prefs.js";

export function useWritingPrefs() {
	return useSyncExternalStore(
		subscribeWritingPrefs,
		getWritingPrefs,
		getWritingPrefs,
	);
}
