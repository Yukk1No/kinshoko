use std::fs;
use std::io::{self, Write as _};
use std::path::Path;

use serde::{Deserialize, Serialize};

const FILE_NAME: &str = "main-window.json";

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct Placement {
    pub(super) maximized: bool,
    pub(super) normal_size: Option<[f64; 2]>,
}

impl Placement {
    pub(super) fn open(dir: &Path) -> io::Result<Self> {
        let mut placement: Self = match fs::read(dir.join(FILE_NAME)) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Self::default(),
            Err(e) => return Err(e),
        };
        placement.normal_size = placement.normal_size.filter(|size| valid_size(*size));
        Ok(placement)
    }

    pub(super) fn save(self, dir: &Path) -> io::Result<()> {
        let path = dir.join(FILE_NAME);
        let tmp = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(&self).map_err(io::Error::other)?;
        let mut out = fs::File::create(&tmp)?;
        out.write_all(&bytes)?;
        out.sync_all()?;
        drop(out);
        fs::rename(tmp, path)
    }

    pub(super) fn observe(&mut self, maximized: bool, size: [f64; 2]) {
        self.maximized = maximized;
        if !maximized && valid_size(size) {
            self.normal_size = Some(size);
        }
    }
}

fn valid_size([width, height]: [f64; 2]) -> bool {
    [width, height]
        .into_iter()
        .all(|value| value.is_finite() && value > 0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maximized_window_reopens_maximized_with_its_last_normal_size() {
        let dir = tempfile::tempdir().unwrap();
        let mut placement = Placement::open(dir.path()).unwrap();
        assert_eq!(placement, Placement::default());

        placement.observe(false, [950.0, 640.0]);
        placement.observe(true, [1920.0, 1040.0]);
        placement.save(dir.path()).unwrap();

        let mut restored = Placement::open(dir.path()).unwrap();
        assert!(restored.maximized);
        assert_eq!(restored.normal_size, Some([950.0, 640.0]));

        restored.observe(false, [950.0, 640.0]);
        restored.save(dir.path()).unwrap();

        assert!(!Placement::open(dir.path()).unwrap().maximized);
    }

    #[test]
    fn invalid_geometry_does_not_override_the_default_normal_size() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        fs::write(&path, "not json").unwrap();
        assert_eq!(Placement::open(dir.path()).unwrap(), Placement::default());

        fs::write(&path, r#"{"maximized":true,"normalSize":[0,640]}"#).unwrap();
        let placement = Placement::open(dir.path()).unwrap();
        assert!(placement.maximized);
        assert_eq!(placement.normal_size, None);
    }
}
