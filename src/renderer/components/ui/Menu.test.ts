// @vitest-environment jsdom

import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "./Button.js";
import { Menu } from "./Menu.js";

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("Menu", () => {
  it("exposes its expanded state and closes with Escape", () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(
          Menu,
          { label: "Session actions" },
          createElement(Button, null, "Delete saved sessions…"),
        ),
      );
    });

    const trigger = container.querySelector("button");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");

    act(() => trigger?.click());
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[role="menu"]')).not.toBeNull();

    act(() => {
      container
        ?.querySelector('[role="menu"]')
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
        );
    });
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
  });
});
