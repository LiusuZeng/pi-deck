// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "./Button.js";
import { Moon } from "./icons.js";
import { Menu } from "./Menu.js";

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let rendererStyle: HTMLStyleElement | undefined;

function installRendererStyles(): void {
  rendererStyle = document.createElement("style");
  rendererStyle.textContent = readFileSync(
    resolve(process.cwd(), "src/renderer/styles.css"),
    "utf8",
  );
  document.head.append(rendererStyle);
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  rendererStyle?.remove();
  root = undefined;
  container = undefined;
  rendererStyle = undefined;
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
    const menu = document.body.querySelector('[role="menu"]');
    const item =
      document.body.querySelector<HTMLButtonElement>('[role="menuitem"]');
    expect(menu?.parentElement).toBe(document.body);
    expect(menu?.getAttribute("style")).toContain("position: fixed");
    expect(menu?.getAttribute("style")).toContain("right: auto");
    expect(menu?.style.visibility).not.toBe("hidden");
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

  it("closes after an item is activated and restores focus to the trigger", () => {
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
      document.body
        .querySelector<HTMLButtonElement>('[role="menuitem"]')
        ?.click(),
    );

    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("dismisses when a pointer goes outside the portalled popover", () => {
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
      document.body.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true }),
      ),
    );

    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
  });

  it("moves between enabled menu items with arrow, Home, and End keys", () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(
          Menu,
          { label: "Appearance" },
          createElement(Button, { role: "menuitemradio" }, "System"),
          createElement(Button, { role: "menuitemradio" }, "Light"),
          createElement(Button, { role: "menuitemradio" }, "Dark"),
        ),
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>("button");
    act(() => trigger?.click());
    const menu = document.body.querySelector('[role="menu"]');
    const items = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>(
        '[role="menuitemradio"]',
      ),
    );
    expect(document.activeElement).toBe(items[0]);

    for (const key of ["ArrowDown", "End", "ArrowDown", "ArrowUp", "Home"]) {
      act(() => {
        menu?.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key }),
        );
      });
    }
    expect(document.activeElement).toBe(items[0]);
  });

  it("keeps wrapper layout classes off the portalled popover", () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(
          Menu,
          {
            className: "workspace-tree-actions",
            label: "Workspace actions",
          },
          createElement(Button, { role: "menuitem" }, "View Work"),
        ),
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>("button");
    expect(container.querySelector(".ui-menu")?.classList).toContain(
      "workspace-tree-actions",
    );

    act(() => trigger?.click());

    const menu = document.body.querySelector('[role="menu"]');
    expect(menu?.classList).toContain("ui-menu-popover");
    expect(menu?.classList).not.toContain("workspace-tree-actions");
  });

  it("keeps workspace action popovers on the base vertical menu layout", () => {
    installRendererStyles();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(
          Menu,
          {
            className: "workspace-tree-actions",
            label: "Workspace actions",
          },
          createElement(Button, { role: "menuitem" }, "View Work"),
          createElement(Button, { role: "menuitem" }, "Rename workspace"),
          createElement(
            Button,
            { role: "menuitem", variant: "danger" },
            "Archive workspace",
          ),
        ),
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>("button");
    act(() => trigger?.click());

    const menu = document.body.querySelector<HTMLElement>('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(getComputedStyle(menu!).display).toBe("grid");
    expect(getComputedStyle(menu!).justifyContent).not.toBe("center");
    expect(
      Array.from(menu!.querySelectorAll('[role="menuitem"]')).map((item) =>
        item.textContent?.trim(),
      ),
    ).toEqual(["View Work", "Rename workspace", "Archive workspace"]);
  });

  it("supports popover-specific classes", () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(
          Menu,
          {
            className: "appearance-trigger",
            label: "Appearance",
            popoverClassName: "appearance-menu",
          },
          createElement(Button, { role: "menuitemradio" }, "Dark"),
        ),
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>("button");
    act(() => trigger?.click());

    const menu = document.body.querySelector('[role="menu"]');
    expect(menu?.classList).toContain("ui-menu-popover");
    expect(menu?.classList).toContain("appearance-menu");
    expect(menu?.classList).not.toContain("appearance-trigger");
  });

  it("supports a disabled loading trigger with a contextual icon", () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(
          Menu,
          {
            disabled: true,
            icon: Moon,
            label: "Appearance: Dark",
            loading: true,
          },
          createElement(Button, { role: "menuitem" }, "Dark"),
        ),
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>("button");
    expect(trigger?.disabled).toBe(true);
    expect(trigger?.getAttribute("aria-busy")).toBe("true");
    expect(trigger?.getAttribute("aria-label")).toBe("Appearance: Dark");
    expect(container.querySelector("svg.lucide-moon")).not.toBeNull();
  });
});
