use std::path::Path;

use crate::utils::{patch_core_file, patch_dsh, PatchOutcome};

const CLIENT: &str = "node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js";
const MARKER: &str = "function useDshMobileSidebar(";
const FRAME: &str =
    "function AppFrame({ useStore, useSessions, usePanelInfo, actions, renderSlot, t }) {";
const HOOK: &str = r#"const DSH_MOBILE_SIDEBAR_CSS = `[data-dsh-mobile-sidebar]{grid-template-columns:minmax(0,1fr)!important;transition:none!important;overscroll-behavior-x:none}[data-dsh-mobile-sidebar] [data-dsh-sidebar-column]{position:absolute;inset:0 auto 0 0;width:var(--dsh-sidebar-width);border:0;visibility:visible}[data-dsh-mobile-sidebar] [data-dsh-center-column]{position:absolute;inset:0;z-index:1;background:var(--dsw-alias-bg-base);transform:translate3d(var(--dsh-sidebar-offset),0,0);border-radius:var(--dsh-sidebar-radius) 0 0 var(--dsh-sidebar-radius);box-shadow:var(--dsh-sidebar-shadow);transition:transform 240ms cubic-bezier(.2,.8,.2,1),border-radius 240ms ease;will-change:transform}[data-dsh-mobile-sidebar][data-dsh-sidebar-dragging] [data-dsh-center-column]{transition:none}[data-dsh-mobile-sidebar] [data-side="sidebar"]{display:none}[data-dsh-sidebar-shade]{position:absolute;inset:0;z-index:2;border:0;padding:0;background:transparent;transform:translate3d(var(--dsh-sidebar-offset),0,0);transition:transform 240ms cubic-bezier(.2,.8,.2,1);touch-action:pan-y pinch-zoom}[data-dsh-sidebar-dragging] [data-dsh-sidebar-shade]{transition:none}[data-dsh-sidebar-toggle]{position:absolute;top:12px;left:12px;z-index:3;width:40px;height:40px;border:0;border-radius:12px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:24px;line-height:1;touch-action:manipulation}@media(prefers-reduced-motion:reduce){[data-dsh-mobile-sidebar] [data-dsh-center-column],[data-dsh-sidebar-shade]{transition:none}}`;
function useDshMobileSidebar(frameRef, collapsed, viewport, actions, blocked) {
    const queries = ["(hover: none)", "(any-pointer: coarse)", "(any-hover: none)"];
    const matches = () => queries.every(query => window.matchMedia(query).matches);
    const [touchDevice, setTouchDevice] = (0, react.useState)(matches);
    const [offset, setOffset] = (0, react.useState)(null);
    const suppressClickUntil = (0, react.useRef)(0);
    const wasOpen = (0, react.useRef)(false);
    const mobile = touchDevice && viewport < 1024 && !blocked;
    const width = Math.min(320, viewport * .82);
    (0, react.useEffect)(() => {
        const media = queries.map(query => window.matchMedia(query));
        const update = () => setTouchDevice(media.every(query => query.matches));
        media.forEach(query => query.addEventListener("change", update));
        update();
        return () => media.forEach(query => query.removeEventListener("change", update));
    }, []);
    (0, react.useLayoutEffect)(() => {
        setOffset(null);
        const frame = frameRef.current;
        const opened = mobile && !collapsed;
        if (frame !== null && (opened || wasOpen.current && mobile)) {
            frame.querySelector(opened ? "[data-dsh-sidebar-column]" : "[data-dsh-sidebar-toggle]")?.focus({ preventScroll: true });
        }
        wasOpen.current = opened;
        if (!mobile || frame === null || blocked) return;
        let gesture = null;
        const base = collapsed ? 0 : width;
        const clamp = x => Math.max(0, Math.min(width, x));
        const sample = (touch, time) => {
            gesture.samples.push({ x: touch.clientX, time });
            while (gesture.samples.length > 2 && gesture.samples[1].time < time - 100) gesture.samples.shift();
        };
        const end = (event, cancelled) => {
            if (gesture === null) return;
            const touch = Array.from(event.changedTouches).find(touch => touch.identifier === gesture.id);
            if (!cancelled && touch === undefined) return;
            const current = gesture;
            if (current.axis === "x") {
                if (touch !== undefined) sample(touch, event.timeStamp);
                const last = current.samples[current.samples.length - 1];
                const first = current.samples[0];
                const velocity = (last.x - first.x) / Math.max(1, last.time - first.time);
                const travel = touch === undefined ? current.travel : touch.clientX - current.x;
                const position = clamp(base + travel);
                const fling = Math.abs(velocity) >= .5 && Math.abs(travel) >= 18;
                const open = fling ? velocity > 0 : position >= width * .5;
                if (!cancelled && open === collapsed) actions.toggleSidebar();
                suppressClickUntil.current = performance.now() + 400;
            }
            gesture = null;
            setOffset(null);
        };
        const start = event => {
            if (event.touches.length !== 1) {
                if (gesture !== null) end(event, true);
                return;
            }
            if (event.defaultPrevented || !window.getSelection()?.isCollapsed) return;
            let target = event.target;
            if (!(target instanceof Element) || target.closest("input,textarea,select,[contenteditable],[data-shell-overlay]")) return;
            while (target !== frame && target !== null) {
                const overflow = getComputedStyle(target).overflowX;
                if ((overflow === "auto" || overflow === "scroll") && target.scrollWidth > target.clientWidth + 1) return;
                target = target.parentElement;
            }
            const touch = event.touches[0];
            gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, travel: 0, axis: null, samples: [{ x: touch.clientX, time: event.timeStamp }] };
        };
        const move = event => {
            if (gesture === null) return;
            if (event.touches.length !== 1) {
                end(event, true);
                return;
            }
            const touch = Array.from(event.touches).find(touch => touch.identifier === gesture.id);
            if (touch === undefined) return;
            const dx = touch.clientX - gesture.x;
            const dy = touch.clientY - gesture.y;
            if (gesture.axis === null) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return;
                if (Math.abs(dy) >= Math.abs(dx) * .8 || collapsed && dx < 0 || !collapsed && dx > 0) {
                    gesture = null;
                    return;
                }
                gesture.axis = "x";
            }
            if (!event.cancelable) {
                end(event, true);
                return;
            }
            event.preventDefault();
            gesture.travel = dx;
            sample(touch, event.timeStamp);
            setOffset(clamp(base + dx));
        };
        const finish = event => end(event, false);
        const cancel = event => end(event, true);
        const click = event => {
            if (performance.now() < suppressClickUntil.current) {
                event.preventDefault();
                event.stopImmediatePropagation();
            }
        };
        const key = event => {
            if (event.key === "Escape" && !event.defaultPrevented && !collapsed) actions.toggleSidebar();
        };
        frame.addEventListener("touchstart", start, { passive: true });
        frame.addEventListener("touchmove", move, { passive: false });
        frame.addEventListener("touchend", finish);
        frame.addEventListener("touchcancel", cancel);
        frame.addEventListener("click", click, true);
        document.addEventListener("keydown", key);
        return () => {
            frame.removeEventListener("touchstart", start);
            frame.removeEventListener("touchmove", move);
            frame.removeEventListener("touchend", finish);
            frame.removeEventListener("touchcancel", cancel);
            frame.removeEventListener("click", click, true);
            document.removeEventListener("keydown", key);
        };
    }, [mobile, width, collapsed, actions, blocked]);
    return { mobile, width, offset: offset ?? (collapsed ? 0 : width), dragging: offset !== null };
}
"#;
const COLLAPSED: &str =
    "const sidebarCollapsed = narrow ? !layoutInfo.narrowExpanded : layoutInfo.sidebar === 0;";
const COLLAPSED_PATCHED: &str = "const sidebarCollapsed = narrow ? !layoutInfo.narrowExpanded : layoutInfo.sidebar === 0;\n            const mobileSidebar = useDshMobileSidebar(frameRef, sidebarCollapsed, viewport, actions, layoutInfo.rightbarShown);";
const SIDEBAR: &str = r#"collapsed: sidebarCollapsed,
                width: cols.sidebar"#;
const SIDEBAR_PATCHED: &str = r#"collapsed: mobileSidebar.mobile ? false : sidebarCollapsed,
                width: mobileSidebar.mobile ? mobileSidebar.width : cols.sidebar"#;
const MEMO: &str = "renderSlot,\n                sidebarCollapsed,\n                cols.sidebar";
const MEMO_PATCHED: &str = "renderSlot,\n                sidebarCollapsed,\n                cols.sidebar,\n                mobileSidebar.mobile,\n                mobileSidebar.width";
const STYLE: &str = "gridTemplateColumns: `${cols.sidebar}px minmax(${cols.rightbar === 0 ? 0 : 400}px, 1fr) minmax(0px, ${rightbarMax}px)`";
const STYLE_PATCHED: &str = r#"gridTemplateColumns: `${cols.sidebar}px minmax(${cols.rightbar === 0 ? 0 : 400}px, 1fr) minmax(0px, ${rightbarMax}px)`,
                    ...mobileSidebar.mobile ? {
                        "--dsh-sidebar-width": `${mobileSidebar.width}px`,
                        "--dsh-sidebar-offset": `${mobileSidebar.offset}px`,
                        "--dsh-sidebar-radius": `${Math.min(24, mobileSidebar.offset * .1)}px`,
                        "--dsh-sidebar-shadow": mobileSidebar.offset > 0 ? "-8px 0 32px #00000018" : "none"
                    } : {}"#;
const ATTR: &str = r#""data-sidebar-collapsed": sidebarCollapsed || void 0,"#;
const ATTR_PATCHED: &str = r#""data-dsh-mobile-sidebar": mobileSidebar.mobile || void 0,
                "data-dsh-sidebar-dragging": mobileSidebar.mobile && mobileSidebar.dragging || void 0,
                "data-sidebar-collapsed": sidebarCollapsed || void 0,"#;
const COLUMN: &str =
    "className: AppFrame_module_css_default.sidebarCol,\n                        children: sidebar";
const COLUMN_PATCHED: &str = r#"className: AppFrame_module_css_default.sidebarCol,
                        "data-dsh-sidebar-column": true,
                        tabIndex: mobileSidebar.mobile ? -1 : void 0,
                        inert: mobileSidebar.mobile && sidebarCollapsed,
                        "aria-hidden": mobileSidebar.mobile && sidebarCollapsed || void 0,
                        children: sidebar"#;
const CENTER: &str = "className: AppFrame_module_css_default.centerCol,";
const CENTER_PATCHED: &str = "className: AppFrame_module_css_default.centerCol,\n                \"data-dsh-center-column\": true,\n                inert: props.inert,\n                \"aria-hidden\": props.inert || void 0,";
const MAIN: &str = "(0, react_jsx_runtime.jsx)(CenterColumn, { children: main })";
const MAIN_PATCHED: &str = "(0, react_jsx_runtime.jsx)(CenterColumn, { inert: mobileSidebar.mobile && !sidebarCollapsed, children: main })";
const CHILDREN: &str = "productTitle,\n                        useSessions,\n                        usePanelInfo\n                    }),";
const CHILDREN_PATCHED: &str = r#"productTitle,
                        useSessions,
                        usePanelInfo
                    }),
                    mobileSidebar.mobile && (0, react_jsx_runtime.jsx)("style", { children: DSH_MOBILE_SIDEBAR_CSS }),
                    mobileSidebar.mobile && sidebarCollapsed && (0, react_jsx_runtime.jsx)("button", {
                        "data-dsh-sidebar-toggle": true,
                        style: { visibility: mobileSidebar.dragging ? "hidden" : "visible" },
                        "aria-label": t("toggle"),
                        "aria-expanded": false,
                        onClick: () => actions.toggleSidebar(),
                        children: "☰"
                    }),
                    mobileSidebar.mobile && !sidebarCollapsed && (0, react_jsx_runtime.jsx)("button", {
                        "data-dsh-sidebar-shade": true,
                        "aria-label": t("toggle"),
                        onClick: () => actions.toggleSidebar()
                    }),"#;

fn patch_source(source: &str) -> PatchOutcome {
    if source.contains(MARKER) {
        return PatchOutcome::AlreadyPatched;
    }
    let replacements = [
        (FRAME, format!("{HOOK}{FRAME}")),
        (COLLAPSED, COLLAPSED_PATCHED.to_string()),
        (SIDEBAR, SIDEBAR_PATCHED.to_string()),
        (MEMO, MEMO_PATCHED.to_string()),
        (STYLE, STYLE_PATCHED.to_string()),
        (ATTR, ATTR_PATCHED.to_string()),
        (COLUMN, COLUMN_PATCHED.to_string()),
        (CENTER, CENTER_PATCHED.to_string()),
        (MAIN, MAIN_PATCHED.to_string()),
        (CHILDREN, CHILDREN_PATCHED.to_string()),
    ];
    let normalized = source.replace('\t', "    ");
    if replacements
        .iter()
        .any(|(anchor, _)| normalized.matches(anchor).count() != 1)
    {
        return PatchOutcome::AnchorMissing;
    }
    let mut result = normalized;
    for (anchor, replacement) in replacements {
        result = result.replacen(anchor, &replacement, 1);
    }
    PatchOutcome::Patched(result)
}

pub fn apply_at(core_dir: &Path) -> Result<(), String> {
    patch_core_file(core_dir, CLIENT, patch_source)
}

pub fn apply(app_handle: &tauri::AppHandle) -> Result<(), String> {
    patch_dsh(app_handle, CLIENT, patch_source)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> String {
        [
            FRAME, COLLAPSED, SIDEBAR, MEMO, STYLE, ATTR, COLUMN, CENTER, MAIN, CHILDREN,
        ]
        .join("\n")
    }

    #[test]
    fn patches_native_gesture_and_validates_all_anchors() {
        let PatchOutcome::Patched(result) = patch_source(&fixture()) else {
            panic!("not patched")
        };
        assert!(result.contains(HOOK));
        assert!(result.contains(SIDEBAR_PATCHED));
        assert!(result.contains(STYLE_PATCHED));
        assert_eq!(patch_source(&result), PatchOutcome::AlreadyPatched);
        assert_eq!(patch_source(""), PatchOutcome::AnchorMissing);
        assert_eq!(
            patch_source(&fixture().replace(MEMO, "")),
            PatchOutcome::AnchorMissing
        );
        assert_eq!(
            patch_source(&format!("{}{FRAME}", fixture())),
            PatchOutcome::AnchorMissing
        );
    }
}
