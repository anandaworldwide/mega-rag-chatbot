import { renderHook, act } from "@testing-library/react";
import { useHideOnScroll } from "@/hooks/useHideOnScroll";

function createScroller() {
  const el = document.createElement("div");
  let scrollTop = 0;
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: 2000 });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: 400 });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  document.body.appendChild(el);
  const ref = { current: el };
  return { el, ref };
}

function scrollTo(el: HTMLElement, top: number) {
  el.scrollTop = top;
  el.dispatchEvent(new Event("scroll"));
}

describe("useHideOnScroll", () => {
  let scroller: ReturnType<typeof createScroller>;

  beforeEach(() => {
    scroller = createScroller();
  });

  afterEach(() => {
    scroller.el.remove();
  });

  it("hides after scrolling down past the threshold and shows after scrolling up", () => {
    const { result } = renderHook(() => useHideOnScroll(scroller.ref, { threshold: 12 }));

    expect(result.current.hidden).toBe(false);

    act(() => {
      scrollTo(scroller.el, 8);
    });
    expect(result.current.hidden).toBe(false);

    act(() => {
      scrollTo(scroller.el, 30);
    });
    expect(result.current.hidden).toBe(true);

    act(() => {
      scrollTo(scroller.el, 10);
    });
    expect(result.current.hidden).toBe(false);
  });

  it("shows the bar when the scroller reaches the bottom", () => {
    const { result } = renderHook(() => useHideOnScroll(scroller.ref, { threshold: 12, bottomOffset: 48 }));

    act(() => {
      scrollTo(scroller.el, 200);
    });
    expect(result.current.hidden).toBe(true);

    act(() => {
      // 2000 - 1560 - 400 = 40, inside the bottom offset
      scrollTo(scroller.el, 1560);
    });
    expect(result.current.hidden).toBe(false);
  });

  it("stays visible while forceVisible is set", () => {
    const { result, rerender } = renderHook(
      ({ forceVisible }) => useHideOnScroll(scroller.ref, { threshold: 12, forceVisible }),
      { initialProps: { forceVisible: false } }
    );

    act(() => {
      scrollTo(scroller.el, 80);
    });
    expect(result.current.hidden).toBe(true);

    rerender({ forceVisible: true });
    expect(result.current.hidden).toBe(false);

    act(() => {
      scrollTo(scroller.el, 200);
    });
    expect(result.current.hidden).toBe(false);
  });

  it("reveal keeps the bar visible through a downward scroll until the user scrolls up", () => {
    const { result } = renderHook(() => useHideOnScroll(scroller.ref, { threshold: 12 }));

    act(() => {
      scrollTo(scroller.el, 100);
    });
    expect(result.current.hidden).toBe(true);

    act(() => {
      result.current.reveal();
    });
    expect(result.current.hidden).toBe(false);

    act(() => {
      scrollTo(scroller.el, 220);
    });
    expect(result.current.hidden).toBe(false);

    act(() => {
      scrollTo(scroller.el, 180);
    });
    act(() => {
      scrollTo(scroller.el, 320);
    });
    expect(result.current.hidden).toBe(true);
  });

  it("does not hide when disabled", () => {
    const { result } = renderHook(() => useHideOnScroll(scroller.ref, { enabled: false, threshold: 12 }));

    act(() => {
      scrollTo(scroller.el, 400);
    });
    expect(result.current.hidden).toBe(false);
  });
});
