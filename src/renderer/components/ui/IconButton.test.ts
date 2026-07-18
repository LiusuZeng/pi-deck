// @vitest-environment jsdom

import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { IconButton } from "./IconButton.js";
import { RefreshCw } from "./icons.js";

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function renderIconButton(
  props: Partial<Parameters<typeof IconButton>[0]> = {},
) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  act(() => {
    root?.render(
      createElement(IconButton, {
        icon: RefreshCw,
        label: "Refresh sessions",
        ...props,
      }),
    );
  });

  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("IconButton", () => {
  it("provides its required label as the button accessible name", () => {
    const view = renderIconButton();
    const button = view.querySelector("button");

    expect(button).not.toBeNull();
    expect(button?.getAttribute("aria-label")).toBe("Refresh sessions");
    expect(button?.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("marks loading controls busy, disables repeat activation, and keeps their size class", () => {
    let clicks = 0;
    const view = renderIconButton({
      loading: true,
      onClick: () => {
        clicks += 1;
      },
      size: "sm",
    });
    const button = view.querySelector("button");

    button?.click();

    expect(button?.getAttribute("aria-busy")).toBe("true");
    expect(button?.disabled).toBe(true);
    expect(button?.classList.contains("ui-control--sm")).toBe(true);
    expect(button?.getAttribute("data-loading")).toBe("true");
    expect(clicks).toBe(0);
  });

  it("exposes selected toggle state with aria-pressed", () => {
    const view = renderIconButton({ pressed: true });

    expect(view.querySelector("button")?.getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("opens its tooltip immediately when focused", () => {
    const view = renderIconButton();
    const button = view.querySelector("button");

    expect(view.firstElementChild).toBe(button);
    expect(button?.hasAttribute("aria-describedby")).toBe(false);
    expect(view.querySelector('[role="tooltip"]')).toBeNull();
    act(() => button?.focus());

    expect(button?.getAttribute("aria-describedby")).toBeTruthy();
    expect(view.querySelector('[role="tooltip"]')?.textContent).toContain(
      "Refresh sessions",
    );

    act(() => button?.blur());
    expect(button?.hasAttribute("aria-describedby")).toBe(false);
  });
});
