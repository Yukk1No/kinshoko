#[derive(Clone, Copy)]
pub(super) enum ReturnTo {
    External,
    Previous(Option<isize>),
}

pub(super) fn target(focused: bool, last_external: isize, destination: ReturnTo) -> Option<isize> {
    if !focused {
        return None;
    }
    match destination {
        ReturnTo::External => Some(last_external),
        ReturnTo::Previous(previous) => previous,
    }
    .filter(|hwnd| *hwnd != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menu_returns_to_main_instead_of_the_last_external_window() {
        assert_eq!(target(true, 20, ReturnTo::Previous(Some(10))), Some(10));
    }

    #[test]
    fn menu_returns_to_the_recorded_external_window() {
        assert_eq!(target(true, 20, ReturnTo::Previous(Some(30))), Some(30));
    }

    #[test]
    fn missing_menu_foreground_does_not_guess_another_window() {
        assert_eq!(target(true, 20, ReturnTo::Previous(None)), None);
        assert_eq!(target(true, 20, ReturnTo::Previous(Some(0))), None);
    }

    #[test]
    fn clicking_another_program_does_not_steal_focus_back() {
        assert_eq!(target(false, 20, ReturnTo::Previous(Some(10))), None);
    }

    #[test]
    fn edge_hide_still_returns_to_the_last_external_window_only_when_ours_is_focused() {
        assert_eq!(target(true, 20, ReturnTo::External), Some(20));
        assert_eq!(target(false, 20, ReturnTo::External), None);
        assert_eq!(target(true, 0, ReturnTo::External), None);
    }
}
