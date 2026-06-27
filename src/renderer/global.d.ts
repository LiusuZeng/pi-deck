import type { PiDeckApi } from "../shared/types.js";

declare global {
  interface Window {
    piDeck: PiDeckApi;
  }
}

export {};
