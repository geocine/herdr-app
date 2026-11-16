// HERDR: the incremental syntect parse behind the script editors' highlighting (syntax.rs).
// Kept free of gpui so it can be tested on its own.
//
// Syntect has no incremental mode of its own, so every keystroke used to reparse the whole
// document (~3-4 ms per KB, on the UI thread). Each line keeps the parser state it starts in:
// an edit is parsed from the line it starts in, until a line after it starts in the same state
// as before the edit; from there the old parse stands, moved. Typing an unclosed `/*` still
// reparses to the end, as before. An edit that doesn't add up to the new text (a change never
// heard of) is parsed from the start.
use std::{collections::HashMap, ops::Range, sync::LazyLock};

use syntect::{
    parsing::{ParseState, Scope, ScopeStack, SyntaxReference, SyntaxSet},
    util::LinesWithEndings,
};

/// Loading the default syntax definitions deserializes a few megabytes, so share
/// one set across every highlighter instance.
pub(crate) static SYNTAX_SET: LazyLock<SyntaxSet> = LazyLock::new(SyntaxSet::load_defaults_newlines);

/// One line's parse: where it starts (bytes), the parser's state before it, and its
/// highlights, as offsets from the line's start.
struct Line {
    start: usize,
    len: usize,
    before: (ParseState, ScopeStack),
    highlights: Vec<(Range<usize>, &'static str)>,
}

/// A document's parse, line by line.
pub(crate) struct Parse {
    syntax: &'static SyntaxReference,
    lines: Vec<Line>,
    /// The text's length at the last parse.
    len: usize,
    /// Scope ids are cheap to compare but expensive to stringify, so remember
    /// the semantic name each one maps to.
    semantic_names: HashMap<Scope, Option<&'static str>>,
    /// Markdown names its markup (headings, code, links) rather than only code scopes.
    markdown: bool,
}

/// An edit's bytes: (start, old end, new end).
pub(crate) type Edit = (usize, usize, usize);

impl Parse {
    pub(crate) fn new(language: &str) -> Option<Self> {
        let syntax = find_syntax(language)?;
        Some(Self { syntax, lines: Vec::new(), len: 0, semantic_names: HashMap::new(), markdown: syntax.name == "Markdown" })
    }

    fn push_highlight(
        names: &mut HashMap<Scope, Option<&'static str>>,
        markdown: bool,
        out: &mut Vec<(Range<usize>, &'static str)>,
        range: Range<usize>,
        scopes: &ScopeStack,
    ) {
        if range.is_empty() {
            return;
        }
        let name = scopes
            .scopes
            .iter()
            .rev()
            .find_map(|scope| *names.entry(*scope).or_insert_with(|| semantic_name(*scope, markdown)));
        if let Some(name) = name {
            out.push((range, name));
        }
    }

    /// One line's highlights (offsets in the line), moving `state` past it.
    fn parse_line(
        names: &mut HashMap<Scope, Option<&'static str>>,
        markdown: bool,
        state: &mut (ParseState, ScopeStack),
        line: &str,
    ) -> Vec<(Range<usize>, &'static str)> {
        let mut out = Vec::new();
        let (parser, scopes) = state;
        if let Ok(operations) = parser.parse_line(line, &SYNTAX_SET) {
            let mut cursor = 0;
            for (index, operation) in operations {
                Self::push_highlight(names, markdown, &mut out, cursor..index, scopes);
                let _ = scopes.apply(&operation);
                cursor = index;
            }
            Self::push_highlight(names, markdown, &mut out, cursor..line.len(), scopes);
        }
        out
    }

    /// The old line to parse again from, for an edit that adds up; None: from the start.
    fn resume_at(&self, edit: Option<Edit>, new_len: usize) -> Option<usize> {
        let (start, old_end, new_end) = edit?;
        if self.lines.is_empty() || start > old_end || old_end > self.len || start > new_end {
            return None;
        }
        if self.len as isize + (new_end as isize - old_end as isize) != new_len as isize {
            return None;
        }
        let i = self.lines.partition_point(|l| l.start + l.len <= start);
        Some(i.min(self.lines.len() - 1))
    }

    /// Brings the parse up to `text` after `edit` (None: parse it all).
    pub(crate) fn apply(&mut self, edit: Option<Edit>, text: &str) {
        let from = self.resume_at(edit, text.len());
        let mut old = std::mem::take(&mut self.lines);
        let (mut state, mut offset, tail) = match from {
            Some(i) => {
                let tail = old.split_off(i);
                (tail[0].before.clone(), tail[0].start, tail)
            }
            None => {
                old.clear();
                ((ParseState::new(self.syntax), ScopeStack::new()), 0, Vec::new())
            }
        };
        let mut lines = old;
        // Where the old text after the edit sits now: an old line starting at or after the
        // edit's old end is the same text, `grown` bytes further along.
        let (old_end, new_end, grown) = match (from, edit) {
            (Some(_), Some((_, old_end, new_end))) => (old_end, new_end, new_end as isize - old_end as isize),
            _ => (usize::MAX, usize::MAX, 0),
        };
        let mut tail = tail.into_iter().peekable();
        for line in LinesWithEndings::from(&text[offset..]) {
            if offset >= new_end {
                let was = (offset as isize - grown) as usize;
                while tail.peek().is_some_and(|l| l.start < was) {
                    tail.next();
                }
                if tail.peek().is_some_and(|l| l.start == was && l.start >= old_end && l.before == state) {
                    lines.extend(tail.map(|mut l| {
                        l.start = (l.start as isize + grown) as usize;
                        l
                    }));
                    self.lines = lines;
                    self.len = text.len();
                    return;
                }
            }
            let before = state.clone();
            let highlights = Self::parse_line(&mut self.semantic_names, self.markdown, &mut state, line);
            lines.push(Line { start: offset, len: line.len(), before, highlights });
            offset += line.len();
        }
        self.lines = lines;
        self.len = text.len();
    }

    /// The highlights overlapping `range`, in document offsets.
    pub(crate) fn highlights_in(&self, range: &Range<usize>) -> Vec<(Range<usize>, &'static str)> {
        let first = self.lines.partition_point(|l| l.start + l.len <= range.start);
        let mut out = Vec::new();
        for line in &self.lines[first..] {
            if line.start >= range.end {
                break;
            }
            out.extend(line.highlights.iter().map(|(r, name)| (line.start + r.start..line.start + r.end, *name)));
        }
        out
    }
}

pub(crate) fn find_syntax(language: &str) -> Option<&'static SyntaxReference> {
    SYNTAX_SET
        .find_syntax_by_token(language)
        .or_else(|| SYNTAX_SET.find_syntax_by_extension(language))
}

pub(crate) fn semantic_name(scope: Scope, markdown: bool) -> Option<&'static str> {
    let scope = scope.build_string();
    // Other grammars, including reStructuredText, use the same markup prefixes.
    if markdown && let Some(name) = markup_name(&scope) {
        return Some(name);
    }
    let name = if scope.starts_with("comment") {
        "comment"
    } else if scope.starts_with("constant.character.escape") {
        "string.escape"
    } else if scope.starts_with("string") {
        "string"
    } else if scope.starts_with("constant.numeric") {
        "number"
    } else if scope.starts_with("constant.language.boolean") {
        "boolean"
    } else if scope.starts_with("keyword.operator") {
        "operator"
    } else if scope.starts_with("keyword") || scope.starts_with("storage") {
        "keyword"
    } else if scope.starts_with("entity.name.function") || scope.starts_with("support.function") {
        "function"
    } else if scope.starts_with("entity.name.type")
        || scope.starts_with("entity.name.class")
        || scope.starts_with("support.type")
    {
        "type"
    } else if scope.starts_with("variable") {
        "variable"
    } else if scope.starts_with("constant") {
        "constant"
    } else if scope.starts_with("punctuation") {
        "punctuation"
    } else {
        return None;
    };
    Some(name)
}

/// HERDR: Markdown's scopes, so a Markdown editor shows its structure. A marker
/// (`#`, `**`, a list bullet) takes its construct's name rather than
/// `punctuation`, the way VS Code colors it. Lists and links name only their
/// marker and URL: the list item's own text stays plain.
fn markup_name(scope: &str) -> Option<&'static str> {
    const NAMES: &[(&[&str], &str)] = &[
        (
            &["markup.heading", "punctuation.definition.heading"],
            "heading",
        ),
        (&["markup.bold", "punctuation.definition.bold"], "strong"),
        (
            &["markup.italic", "punctuation.definition.italic"],
            "emphasis",
        ),
        (&["markup.raw", "punctuation.definition.raw"], "code"),
        (
            &["markup.quote", "punctuation.definition.blockquote"],
            "quote",
        ),
        (
            &[
                "markup.list.numbered.bullet",
                "markup.list.unnumbered.bullet",
                "punctuation.definition.list_item",
            ],
            "list",
        ),
        (&["markup.underline.link"], "link"),
    ];
    NAMES
        .iter()
        .find(|(prefixes, _)| prefixes.iter().any(|prefix| scope.starts_with(prefix)))
        .map(|(_, name)| *name)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every line's start and highlights, in document offsets: what styles() draws from.
    fn snapshot(h: &Parse) -> Vec<(usize, Vec<(Range<usize>, &'static str)>)> {
        h.lines.iter().map(|l| (l.start, h.highlights_in(&(l.start..l.start + l.len.max(1))))).collect()
    }

    fn sample() -> String {
        let block = "// a comment with é and 😀\r\n\
            const x = `template ${a + 1}\n  still template`;\n\
            /* block\n   comment */\n\
            function f(a, b) {\n\treturn a + \"str\\\" ing\" + 'c';\n}\r\n\
            class K extends B { m() { return /re+gex/.test(s); } }\n";
        let mut out = String::new();
        while out.len() < 100_000 {
            out.push_str(block);
        }
        out
    }

    /// A tiny deterministic generator: the test needs variety, not quality.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self, n: usize) -> usize {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((self.0 >> 33) as usize) % n.max(1)
        }
    }

    fn boundary(text: &str, mut at: usize) -> usize {
        at = at.min(text.len());
        while !text.is_char_boundary(at) {
            at -= 1;
        }
        at
    }

    #[test]
    fn incremental_highlights_match_a_full_parse_after_every_edit() {
        let mut text = sample();
        let mut live = Parse::new("js").unwrap();
        live.apply(None, &text);
        let mut rng = Rng(7);
        let inserts = ["/*", "*/", "`", "\n", "\r\n", "é", "😀", "{", "}", "\"", "'", "abc", "// x", "\t", ""];
        for step in 0..400 {
            let (start, old_end, ins) = match step {
                // The ends of the text, and everything deleted then typed again.
                0 => (0, 0, "/*"),
                1 => (text.len(), text.len(), "\n`"),
                2 => (0, text.len(), ""),
                3 => (0, 0, "let a = 1;\n"),
                _ => {
                    let a = boundary(&text, rng.next(text.len() + 1));
                    let b = if rng.next(3) == 0 { boundary(&text, a + rng.next(40)) } else { a };
                    (a, b.max(a), inserts[rng.next(inserts.len())])
                }
            };
            if step == 4 {
                text = sample();
                live.apply(None, &text);
                continue;
            }
            text.replace_range(start..old_end, ins);
            live.apply(Some((start, old_end, start + ins.len())), &text);
            let mut fresh = Parse::new("js").unwrap();
            fresh.apply(None, &text);
            assert_eq!(snapshot(&live), snapshot(&fresh), "step {step}: edit {start}..{old_end} -> {ins:?}");
            assert_eq!(live.len, text.len());
        }
    }

    #[test]
    fn edits_that_dont_add_up_are_parsed_again_from_the_start() {
        let mut live = Parse::new("js").unwrap();
        live.apply(None, "let a = 1;\n");
        // The highlighter never heard of a change: a stale edit must not be trusted.
        let text = "/* now a comment */\nlet b = 2;\n";
        live.apply(Some((0, 0, 1)), text);
        let mut fresh = Parse::new("js").unwrap();
        fresh.apply(None, text);
        assert_eq!(snapshot(&live), snapshot(&fresh));
    }

    #[test]
    fn a_keystroke_parses_a_line_not_the_file() {
        let mut text = sample();
        let mut live = Parse::new("js").unwrap();
        let t = std::time::Instant::now();
        live.apply(None, &text);
        let full = t.elapsed();
        let at = boundary(&text, text.len() / 2);
        let at = text[at..].find('\n').map_or(at, |n| at + n);
        text.insert(at, 'x');
        let t = std::time::Instant::now();
        live.apply(Some((at, at, at + 1)), &text);
        let one = t.elapsed();
        eprintln!("100 KB: full parse {full:?}, one keystroke {one:?}");
        assert!(one * 10 < full, "a keystroke ({one:?}) should cost a small part of a full parse ({full:?})");
    }
}
