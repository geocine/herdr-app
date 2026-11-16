// HERDR: built-in pure-Rust syntax highlighting for script editors, adapted from Base's showcase.
// The parse itself (incremental) is syntax_core.rs.
use std::{collections::HashMap, ops::Range};

use gpui::{Context, HighlightStyle, SharedString, Window};
use gpui_base::input::{
    EditorState, FoldRange, HighlightStyleResolver, InputEdit, InputHighlighter, Rope,
};

use crate::syntax_core::Parse;
#[cfg(test)]
use crate::syntax_core::find_syntax;

/// Base's parser-independent highlighting API over syntect, which identifies scopes; the
/// application-owned resolver supplies all colors and font styles.
pub(crate) struct SyntectHighlighter {
    language: SharedString,
    parse: Parse,
    fold_ranges: Vec<FoldRange>,
}

impl SyntectHighlighter {
    pub(crate) fn new(language: &str) -> Option<Self> {
        Some(Self { language: language.to_owned().into(), parse: Parse::new(language)?, fold_ranges: Vec::new() })
    }
}

impl InputHighlighter for SyntectHighlighter {
    fn language(&self) -> SharedString {
        self.language.clone()
    }

    fn update(
        &mut self,
        edit: Option<InputEdit>,
        text: &Rope,
        folding: bool,
        _window: &mut Window,
        _cx: &mut Context<EditorState>,
    ) {
        // Read the rope once and reuse that string for folding too.
        let text = text.to_string();
        self.parse.apply(edit.map(|e| (e.start_byte, e.old_end_byte, e.new_end_byte)), &text);
        self.fold_ranges = if folding {
            brace_fold_ranges(&text)
        } else {
            Vec::new()
        };
    }

    fn styles(
        &self,
        range: &Range<usize>,
        resolver: &dyn HighlightStyleResolver,
    ) -> Vec<(Range<usize>, HighlightStyle)> {
        resolve_styles(&self.parse.highlights_in(range), range, resolver)
    }

    fn fold_ranges(&self, _: &Rope) -> Vec<FoldRange> {
        self.fold_ranges.clone()
    }

    fn fold_ranges_for_edit(&self, _: Range<usize>, _: &Rope) -> Vec<FoldRange> {
        self.fold_ranges.clone()
    }
}

/// Turn the highlights overlapping `range` into gap-free style runs.
///
/// `highlights` is ordered and non-overlapping, so the first candidate is found
/// by binary search instead of scanning the whole document on every frame.
fn resolve_styles(
    highlights: &[(Range<usize>, &'static str)],
    range: &Range<usize>,
    resolver: &dyn HighlightStyleResolver,
) -> Vec<(Range<usize>, HighlightStyle)> {
    let first = highlights.partition_point(|(highlight, _)| highlight.end <= range.start);
    let mut runs = Vec::new();
    let mut cursor = range.start;

    for (highlight_range, name) in &highlights[first..] {
        if highlight_range.start >= range.end {
            break;
        }

        let start = highlight_range.start.max(range.start);
        let end = highlight_range.end.min(range.end);
        if start >= end || end <= cursor {
            continue;
        }
        if cursor < start {
            runs.push((cursor..start, HighlightStyle::default()));
        }
        runs.push((start..end, resolver.style(name).unwrap_or_default()));
        cursor = end;
    }

    if cursor < range.end {
        runs.push((cursor..range.end, HighlightStyle::default()));
    }
    runs
}

/// HERDR: a Markdown name a mod gave no color takes the color of a code name,
/// so a mod that themes `keyword`, `string` and `comment` themes Markdown too.
fn markup_fallback(root: &str) -> Option<&'static str> {
    Some(match root {
        "heading" | "strong" | "list" => "keyword",
        "code" => "string",
        "quote" => "comment",
        "link" => "function",
        _ => return None,
    })
}

fn brace_fold_ranges(text: &str) -> Vec<FoldRange> {
    let mut starts = Vec::new();
    let mut ranges = Vec::new();

    for (line_number, line) in text.lines().enumerate() {
        let mut chars = line.chars().peekable();
        let mut quoted = false;
        let mut escaped = false;
        while let Some(character) = chars.next() {
            if !quoted && character == '/' && chars.peek() == Some(&'/') {
                break;
            }
            if character == '"' && !escaped {
                quoted = !quoted;
            } else if !quoted && character == '{' {
                starts.push(line_number);
            } else if !quoted && character == '}' {
                if let Some(start_line) = starts.pop() {
                    if start_line < line_number {
                        ranges.push(FoldRange::new(start_line, line_number));
                    }
                }
            }
            escaped = quoted && character == '\\' && !escaped;
            if character != '\\' {
                escaped = false;
            }
        }
    }
    ranges
}

/// HERDR: semantic overrides fall back to readable, dark-editor defaults.
#[derive(Default)]
pub(crate) struct SyntaxStyles(pub std::collections::HashMap<String, gpui::Hsla>);

impl HighlightStyleResolver for SyntaxStyles {
    fn style(&self, name: &str) -> Option<HighlightStyle> {
        let root = name.split('.').next()?;
        let fallback = markup_fallback(root);
        let color = self
            .0
            .get(name)
            .or_else(|| self.0.get(root))
            .or_else(|| fallback.and_then(|fallback| self.0.get(fallback)))
            .copied()
            .or_else(|| {
                let rgb = match fallback.unwrap_or(root) {
                    "comment" => 0x7f848e,
                    "string" => 0x98c379,
                    "number" => 0xd19a66,
                    "keyword" => 0xc678dd,
                    "boolean" | "constant" => 0xe5c07b,
                    "function" => 0x61afef,
                    "type" => 0xe5c07b,
                    "operator" => 0x56b6c2,
                    // Unclassified identifiers and punctuation follow the theme foreground.
                    _ => return None,
                };
                Some(gpui::rgb(rgb).into())
            });
        let font_weight = matches!(root, "heading" | "strong").then_some(gpui::FontWeight::BOLD);
        let font_style = (root == "emphasis").then_some(gpui::FontStyle::Italic);
        (color.is_some() || font_weight.is_some() || font_style.is_some()).then(|| HighlightStyle {
            color,
            font_weight,
            font_style,
            ..Default::default()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolved_styles_cover_the_requested_range_without_gaps() {
        let runs = resolve_styles(
            &[(2..4, "keyword"), (6..8, "string")],
            &(0..10),
            &SyntaxStyles::default(),
        );
        let ranges: Vec<_> = runs.into_iter().map(|(range, _)| range).collect();
        assert_eq!(ranges, vec![0..2, 2..4, 4..6, 6..8, 8..10]);
    }

    #[test]
    fn semantic_overrides_and_nested_names_resolve() {
        let color = gpui::rgb(0xc678dd).into();
        let styles = SyntaxStyles(HashMap::from([("string".into(), color)]));
        assert_eq!(styles.style("string.escape").unwrap().color, Some(color));
        assert!(styles.style("keyword").is_some());
        assert!(find_syntax("rust").is_some());
        assert!(find_syntax("rs").is_some());
        assert!(find_syntax("unknown-language").is_none());
    }

    fn highlight_names<'a>(language: &str, text: &'a str) -> Vec<(&'a str, &'static str)> {
        let mut highlighter = SyntectHighlighter::new(language).unwrap();
        highlighter.parse.apply(None, text);
        highlighter
            .parse
            .highlights_in(&(0..text.len()))
            .into_iter()
            .map(|(range, name)| (text[range].trim(), name))
            .filter(|(text, _)| !text.is_empty())
            .collect()
    }

    #[test]
    fn markdown_shows_its_structure() {
        let text =
            "# Title\n\n- item with `code` and **bold** and *it*\n\n> quote\n\n[x](http://x)\n";
        let names = highlight_names("markdown", text);
        assert_eq!(highlight_names("md", text), names);
        for expected in [
            ("#", "heading"),
            ("Title", "heading"),
            ("-", "list"),
            ("`", "code"),
            ("code", "code"),
            ("**", "strong"),
            ("bold", "strong"),
            ("it", "emphasis"),
            ("quote", "quote"),
            ("http://x", "link"),
        ] {
            assert!(names.contains(&expected), "{expected:?} not in {names:?}");
        }
        assert!(!names.iter().any(|(text, _)| text.contains("item with")));
    }

    #[test]
    fn restructuredtext_keeps_its_existing_syntax() {
        let names = highlight_names("rst", "**strong** and *emphasis* and ``literal``.\n");
        assert!(names.contains(&("**", "punctuation")), "{names:?}");
        assert!(
            !names
                .iter()
                .any(|(text, _)| matches!(*text, "strong" | "emphasis" | "literal")),
            "{names:?}"
        );
    }

    #[test]
    fn markdown_names_follow_code_colors_and_set_weight() {
        let keyword = gpui::rgb(0x112233).into();
        let heading = gpui::rgb(0x445566).into();
        let styles = SyntaxStyles(HashMap::from([("keyword".into(), keyword)]));
        let style = styles.style("heading").unwrap();
        assert_eq!(style.color, Some(keyword));
        assert_eq!(style.font_weight, Some(gpui::FontWeight::BOLD));
        assert_eq!(
            styles.style("emphasis").unwrap().font_style,
            Some(gpui::FontStyle::Italic)
        );
        assert!(styles.style("code").unwrap().color.is_some());

        let styles = SyntaxStyles(HashMap::from([
            ("keyword".into(), keyword),
            ("heading".into(), heading),
        ]));
        assert_eq!(styles.style("heading").unwrap().color, Some(heading));
    }
}
