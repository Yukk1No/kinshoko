use super::*;

#[test]
fn errors_reach_the_interface_as_a_code_with_parameters() {
    let json = |e: CommandError| serde_json::to_value(e).unwrap();
    let text = |e: CommandError| e.to_string();
    assert_eq!(
        json(library::Error::CursorExpired.into()),
        serde_json::json!({ "code": "cursorExpired" })
    );
    assert_eq!(
        json(library::Error::AmbiguousTag("猫".into()).into()),
        serde_json::json!({ "code": "ambiguousTag", "name": "猫" })
    );
    assert_eq!(
        json(DeviceLibraryError::Library(library::Error::UnknownImage).into()),
        serde_json::json!({ "code": "unknownImage" })
    );
    assert_eq!(
        json(CatalogError::Library(library::Error::LensChanged).into()),
        serde_json::json!({ "code": "lensChanged" })
    );
    assert_eq!(
        json(
            DeviceLibraryError::Unavailable {
                root: "E:\\库".into(),
                reason: "拒绝访问".into()
            }
            .into()
        ),
        serde_json::json!({
            "code": "libraryUnavailable",
            "root": "E:\\库",
            "cause": { "code": "message", "message": "拒绝访问" }
        })
    );
    assert_eq!(
        text(library::Error::UnknownImage.into()),
        "资料库中没有这张参考图"
    );
    assert_eq!(
        json(CommandError::message("没有代码")),
        serde_json::json!({ "code": "message", "message": "没有代码" })
    );
}
