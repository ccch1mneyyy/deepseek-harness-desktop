use std::path::Path;

use crate::utils::{patch_core_file, patch_dsh, PatchOutcome};

const CLIENT: &str = "node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js";
const MARKER: &str = "function isDshMobileComposer()";
const MOBILE: &str = r#"function isDshMobileComposer() {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" && ["(hover: none)", "(any-pointer: coarse)", "(any-hover: none)"].every(query => window.matchMedia(query).matches);
}
"#;
const KEYMAP: &str = "function registerComposerKeymap(editor, handlers) {";
const ENTER: &str = "if (event !== null && (event.altKey || event.getModifierState(\"AltGraph\") || event.ctrlKey && event.metaKey || event.shiftKey && (event.ctrlKey || event.metaKey))) return true;";
const ENTER_PATCHED: &str = r#"if (isDshMobileComposer()) return event !== null && isComposingEvent(event, recentlyComposing);
                if (event !== null && (event.altKey || event.getModifierState("AltGraph") || event.ctrlKey && event.metaKey || event.shiftKey && (event.ctrlKey || event.metaKey))) return true;"#;
const AUTOFOCUS: &str = "if (locked || editor === null) return;";
const AUTOFOCUS_PATCHED: &str = "if (locked || editor === null || isDshMobileComposer()) return;";

fn patch_source(source: &str) -> PatchOutcome {
    if source.contains(MARKER) {
        return PatchOutcome::AlreadyPatched;
    }
    if [KEYMAP, ENTER, AUTOFOCUS]
        .iter()
        .any(|anchor| source.matches(anchor).count() != 1)
    {
        return PatchOutcome::AnchorMissing;
    }
    PatchOutcome::Patched(
        source
            .replacen(KEYMAP, &format!("{MOBILE}{KEYMAP}"), 1)
            .replacen(ENTER, ENTER_PATCHED, 1)
            .replacen(AUTOFOCUS, AUTOFOCUS_PATCHED, 1),
    )
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
        format!("{KEYMAP}\n{ENTER}\n}}\n{AUTOFOCUS}\nfocusDraftEditor(editor, revealSelection);\n")
    }

    #[test]
    fn guards_only_automatic_focus_and_enter_submission() {
        let PatchOutcome::Patched(result) = patch_source(&fixture()) else {
            panic!("not patched")
        };
        assert!(result.contains(MOBILE));
        assert!(result.contains(ENTER_PATCHED));
        assert!(result.contains(AUTOFOCUS_PATCHED));
        assert!(result.contains("focusDraftEditor(editor, revealSelection);"));
        assert_eq!(patch_source(&result), PatchOutcome::AlreadyPatched);
    }

    #[test]
    fn changed_or_ambiguous_anchors_do_not_apply_a_partial_patch() {
        assert_eq!(patch_source(""), PatchOutcome::AnchorMissing);
        assert_eq!(
            patch_source(&fixture().replace(ENTER, "")),
            PatchOutcome::AnchorMissing
        );
        assert_eq!(
            patch_source(&format!("{}{AUTOFOCUS}", fixture())),
            PatchOutcome::AnchorMissing
        );
    }
}
