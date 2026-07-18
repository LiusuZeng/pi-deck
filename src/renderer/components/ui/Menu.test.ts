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
  it("uses menu semantics, moves focus to an item, and restores the trigger on Escape", () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(
          Menu,
          { label: "Session actions" },
          createElement(Button, { role: "menuitem" }, "Delete saved sessions…"),
        ),
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>("button");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(trigger?.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger?.hasAttribute("aria-controls")).toBe(false);

    act(() => trigger?.click());
    const menu = container.querySelector('[role="menu"]');
    const item =
      container.querySelector<HTMLButtonElement>('[role="menuitem"]');
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    expect(trigger?.getAttribute("aria-controls")).toBe(menu?.id);
    expect(menu).not.toBeNull();
    expect(document.activeElement).toBe(item);

    act(() => {
      menu?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
      );
    });
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("closes after an item is activated", () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(
          Menu,
          { label: "Session actions" },
          createElement(Button, { role: "menuitem" }, "Delete saved sessions…"),
        ),
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>("button");
    act(() => trigger?.click());
    act(() =>
      container?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.click(),
    );

    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });
});
