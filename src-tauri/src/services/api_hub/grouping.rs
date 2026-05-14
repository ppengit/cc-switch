//! Api-Hub 分组 / 模型匹配规则

use std::collections::HashSet;

use super::types::{GroupInfo, ModelInfo};

/// 返回至少包含一个模型的分组名。
///
/// api-hub 中部分模型的 enable_groups 为空，表示模型对所有分组可用。
pub(crate) fn group_names_with_models(
    groups: &[GroupInfo],
    models: &[ModelInfo],
) -> HashSet<String> {
    let group_names: HashSet<String> = groups.iter().map(|group| group.name.clone()).collect();
    let mut result = HashSet::new();

    for model in models {
        if model.enable_groups.is_empty() {
            result.extend(group_names.iter().cloned());
            continue;
        }

        for group in &model.enable_groups {
            if group_names.contains(group) {
                result.insert(group.clone());
            }
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn group(name: &str) -> GroupInfo {
        GroupInfo {
            name: name.to_string(),
            ratio: None,
            description: None,
        }
    }

    fn model(name: &str, enable_groups: &[&str]) -> ModelInfo {
        ModelInfo {
            name: name.to_string(),
            enable_groups: enable_groups
                .iter()
                .map(|group| group.to_string())
                .collect(),
        }
    }

    #[test]
    fn group_names_with_models_ignores_groups_without_models() {
        let groups = vec![group("default"), group("vip"), group("empty")];
        let models = vec![model("gpt-5", &["vip"])];

        let result = group_names_with_models(&groups, &models);

        assert_eq!(result.len(), 1);
        assert!(result.contains("vip"));
        assert!(!result.contains("default"));
        assert!(!result.contains("empty"));
    }

    #[test]
    fn group_names_with_models_treats_empty_enable_groups_as_all_groups() {
        let groups = vec![group("default"), group("vip")];
        let models = vec![model("fallback", &[])];

        let result = group_names_with_models(&groups, &models);

        assert_eq!(result.len(), 2);
        assert!(result.contains("default"));
        assert!(result.contains("vip"));
    }
}
