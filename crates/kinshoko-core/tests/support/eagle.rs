//! 移植 #8 的 make_eagle_fixture.py：真 PNG、嵌套文件夹、多来源与未知字段。

use std::path::{Path, PathBuf};

use image::RgbaImage;
use serde_json::{Value, json};

pub struct EagleFixture {
    pub root: PathBuf,
    pub items: Vec<Value>,
}

impl EagleFixture {
    pub fn item_dir(&self, index: usize) -> PathBuf {
        self.root.join("images").join(format!(
            "{}.info",
            self.items[index]["id"].as_str().unwrap()
        ))
    }

    pub fn original(&self, index: usize) -> PathBuf {
        self.item_dir(index).join(format!(
            "{}.{}",
            self.items[index]["name"].as_str().unwrap(),
            self.items[index]["ext"].as_str().unwrap()
        ))
    }

    pub fn save_item(&self, index: usize) {
        write_json(
            &self.item_dir(index).join("metadata.json"),
            &self.items[index],
        );
    }
}

pub fn write_json(path: &Path, value: &Value) {
    std::fs::write(path, serde_json::to_string_pretty(value).unwrap()).unwrap();
}

pub fn build(root: &Path, version: &str, n: usize) -> EagleFixture {
    std::fs::create_dir_all(root.join("images")).unwrap();
    let mut fixture = EagleFixture {
        root: root.to_path_buf(),
        items: Vec::new(),
    };
    for i in 0..n {
        let seed = if i == 8 { 7 } else { i };
        let (width, height) = (20 + seed as u32 % 30, 20 + seed as u32 % 17);
        let item_dir = root.join(format!("images/ITEM{i:09}.info"));
        std::fs::create_dir_all(&item_dir).unwrap();
        let original = item_dir.join(format!("图{i:04}.png"));
        RgbaImage::from_fn(width, height, |x, y| {
            image::Rgba([seed as u8, x as u8, y as u8, 200])
        })
        .save(&original)
        .unwrap();
        RgbaImage::new(4, 4)
            .save(item_dir.join(format!("图{i:04}_thumbnail.png")))
            .unwrap();
        let comments = if i % 25 == 3 {
            json!([{"id": "C1", "x": 2, "y": 3, "width": 4, "height": 5,
                "annotation": "眼睛", "lastModified": 1760000000000_i64,
                "futureCoordinate": {"basis": "未知"}}])
        } else {
            json!([])
        };
        fixture.items.push(json!({
            "id": format!("ITEM{i:09}"), "name": format!("图{i:04}"), "ext": "png",
            "size": std::fs::metadata(&original).unwrap().len(), "width": width, "height": height,
            "tags": ["蓝发", format!("标签{i}")],
            "folders": if i % 3 == 2 {json!([])} else {json!(["GIRL", "HAIR"])},
            "annotation": format!("看高光{i}"), "url": format!("https://example.com/{i}"),
            "btime": 1756571097667_i64 + i as i64, "mtime": 1756571098667_i64,
            "modificationTime": 1756571099667_i64 + i as i64, "lastModified": 1756571100667_i64,
            "isDeleted": i % 40 == 5, "deletedTime": 1756571200000_i64 + i as i64,
            "comments": comments, "noThumbnail": false, "star": 3,
            "palettes": [{"color": [12,34,56], "ratio": 61, "$$hashKey": "object:1"}],
            "futureField": {"note": "未知字段，导入须原样保留"}
        }));
        fixture.save_item(i);
    }
    write_json(
        &root.join("metadata.json"),
        &json!({
            "folders": [{"id": "ROLE", "name": "角色", "children": [
                {"id": "GIRL", "name": "女", "children": [], "future": true}
            ]}, {"id": "HAIR", "name": "发型参考", "children": []},
            {"id": "EMPTY", "name": "空文件夹", "children": []}],
            "smartFolders": [{"id": "S1", "name": "蓝发", "conditions": []}],
            "tagsGroups": [{"id": "TG1", "name": "发色", "tags": ["蓝发"]}],
            "quickAccess": [{"type": "folder", "id": "HAIR"}],
            "applicationVersion": version, "modificationTime": 1760228119055_i64,
            "futureLibraryField": ["保留"]
        }),
    );
    // #8 的真实库中 all 曾为 3、实际为 2126；此处故意提供错误计数。
    write_json(&root.join("mtime.json"), &json!({"all": 0}));
    fixture
}
