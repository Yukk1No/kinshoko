//! 备份范围（#69，#8 的 Q43 检查）：默认全部已登记的资料库与参考组；按库缩小时一次算清关联参考组、
//! 完整外库与继续延伸的依赖（含循环关联），不补选时列明没覆盖的内容。
//!
//! 与 #8 原型同一组数据：主库 A、旧库 B、散图库 C；参考组“眼睛参考”(A,B)、“光照”(B,C)、
//! “散图”(C)、“空组”（不引用任何库）、“闭环”(C,A)。

use std::collections::BTreeSet;

use kinshoko_core::RegisteredLibrary;
use kinshoko_core::backup::{BackupScope, ScopeSelection, ScopeStep, Uncovered, compute_scope};
use kinshoko_core::reference_groups::GroupSummary;

fn library(id: &str, name: &str) -> RegisteredLibrary {
    RegisteredLibrary {
        id: id.into(),
        name: name.into(),
        root: format!("D:/{id}").into(),
    }
}

fn group(id: &str, name: &str, libraries: &[&str]) -> GroupSummary {
    GroupSummary {
        id: id.into(),
        name: name.into(),
        member_count: libraries.len(),
        library_ids: libraries.iter().map(|l| l.to_string()).collect(),
        updated_at: 0,
        problem: None,
    }
}

fn device() -> (Vec<RegisteredLibrary>, Vec<GroupSummary>) {
    (
        vec![
            library("A", "主库"),
            library("B", "旧库"),
            library("C", "散图库"),
        ],
        vec![
            group("g-eye", "眼睛参考", &["A", "B"]),
            group("g-light", "光照", &["B", "C"]),
            group("g-loose", "散图", &["C"]),
            group("g-empty", "空组", &[]),
            group("g-loop", "闭环", &["C", "A"]),
        ],
    )
}

fn libraries(scope: &BackupScope) -> BTreeSet<&str> {
    scope.libraries.iter().map(|l| l.name.as_str()).collect()
}

fn groups(scope: &BackupScope) -> BTreeSet<&str> {
    scope.groups.iter().map(|g| g.name.as_str()).collect()
}

/// 没覆盖的（参考组，资料库）对。
fn uncovered(scope: &BackupScope) -> BTreeSet<(&str, &str)> {
    scope
        .uncovered
        .iter()
        .map(|u| match u {
            Uncovered::Library {
                group, library_id, ..
            } => (group.name.as_str(), library_id.as_str()),
            Uncovered::UnreadableGroup { group, .. } => (group.name.as_str(), ""),
        })
        .collect()
}

fn only(ids: &[&str], include_linked: bool) -> ScopeSelection {
    ScopeSelection::Libraries {
        ids: ids.iter().map(|s| s.to_string()).collect(),
        include_linked,
    }
}

#[test]
fn by_default_every_registered_library_and_group_is_backed_up_including_groups_without_a_library()
{
    let (libs, gs) = device();
    let scope = compute_scope(&libs, &gs, &ScopeSelection::All);
    assert_eq!(libraries(&scope), BTreeSet::from(["主库", "旧库", "散图库"]));
    assert_eq!(
        groups(&scope),
        BTreeSet::from(["眼睛参考", "光照", "散图", "空组", "闭环"])
    );
    assert!(scope.uncovered.is_empty());
}

#[test]
fn narrowing_to_one_library_follows_the_a_b_and_b_c_chains_and_the_c_a_loop_in_one_pass() {
    let (libs, gs) = device();
    let scope = compute_scope(&libs, &gs, &only(&["A"], true));
    assert_eq!(libraries(&scope), BTreeSet::from(["主库", "旧库", "散图库"]));
    assert_eq!(
        groups(&scope),
        BTreeSet::from(["眼睛参考", "光照", "散图", "闭环"]),
        "空组不被牵入"
    );
    assert!(scope.uncovered.is_empty());
    // 每一步都说明为什么带上：关联参考组，以及参考组还引用的完整外库。
    assert!(scope.steps.contains(&ScopeStep::LinkedGroup {
        library_id: "A".into(),
        group_id: "g-eye".into()
    }));
    assert!(scope.steps.contains(&ScopeStep::AddedLibrary {
        group_id: "g-eye".into(),
        library_id: "B".into()
    }));
    assert!(scope.steps.contains(&ScopeStep::LinkedGroup {
        library_id: "B".into(),
        group_id: "g-light".into()
    }));
    let added_c = scope
        .steps
        .iter()
        .filter(|s| matches!(s, ScopeStep::AddedLibrary { library_id, .. } if library_id == "C"))
        .count();
    assert_eq!(added_c, 1, "循环关联也只补选一次并终止");
}

#[test]
fn declining_the_linked_libraries_lists_what_is_left_uncovered() {
    let (libs, gs) = device();
    let scope = compute_scope(&libs, &gs, &only(&["A"], false));
    assert_eq!(libraries(&scope), BTreeSet::from(["主库"]));
    assert_eq!(groups(&scope), BTreeSet::from(["眼睛参考", "闭环"]));
    assert_eq!(
        uncovered(&scope),
        BTreeSet::from([("眼睛参考", "B"), ("闭环", "C")])
    );
}

#[test]
fn starting_in_the_middle_of_the_chain_lists_both_sides_as_uncovered() {
    let (libs, gs) = device();
    let scope = compute_scope(&libs, &gs, &only(&["B"], false));
    assert_eq!(libraries(&scope), BTreeSet::from(["旧库"]));
    assert_eq!(groups(&scope), BTreeSet::from(["眼睛参考", "光照"]));
    assert_eq!(
        uncovered(&scope),
        BTreeSet::from([("眼睛参考", "A"), ("光照", "C")])
    );
}

#[test]
fn libraries_not_registered_on_this_device_and_unreadable_groups_are_reported_as_uncovered() {
    let (libs, mut gs) = device();
    gs.push(group("g-far", "外借", &["A", "Z"]));
    gs.push(GroupSummary {
        problem: Some("参考组文件已损坏".into()),
        ..group("g-bad", "g-bad", &[])
    });
    let scope = compute_scope(&libs, &gs, &ScopeSelection::All);
    assert!(groups(&scope).contains("外借"));
    assert!(!groups(&scope).contains("g-bad"), "读不懂的参考组无法备份");
    let far = scope
        .uncovered
        .iter()
        .find_map(|u| match u {
            Uncovered::Library {
                group,
                library_id,
                library_name,
            } if group.name == "外借" => Some((library_id.clone(), library_name.clone())),
            _ => None,
        })
        .expect("没登记的库列为未覆盖");
    assert_eq!(far, ("Z".into(), None));
    assert!(
        scope
            .uncovered
            .iter()
            .any(|u| matches!(u, Uncovered::UnreadableGroup { group, .. } if group.id == "g-bad"))
    );
}
