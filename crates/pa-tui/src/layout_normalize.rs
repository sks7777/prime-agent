//! Russian keyboard layout normalization: maps Cyrillic codepoints to their
//! Latin physical-key equivalents so keybindings match regardless of the
//! active keyboard layout.
//!
//! When the Kitty keyboard protocol is active but the terminal does not send
//! `baseLayoutKey` (e.g. VS Code's xterm.js without Shift), the CSI-u
//! codepoint is the Cyrillic character (e.g. щ=1097), not the Latin one
//! (o=111). This mapping bridges that gap.
//!
//! Only applies when a modifier key is active (ctrl, alt, super); plain text
//! input passes through unchanged.

/// Cyrillic codepoint -> Latin codepoint on the same physical key.
const RU_LAYOUT_MAP: &[(char, char)] = &[
    // Lowercase letters: Cyrillic -> Latin (same physical key)
    ('й', 'q'), ('ц', 'w'), ('у', 'e'), ('к', 'r'), ('е', 't'),
    ('н', 'y'), ('г', 'u'), ('ш', 'i'), ('щ', 'o'), ('з', 'p'),
    ('ф', 'a'), ('ы', 's'), ('в', 'd'), ('а', 'f'), ('п', 'g'),
    ('р', 'h'), ('о', 'j'), ('л', 'k'), ('д', 'l'),
    ('я', 'z'), ('ч', 'x'), ('с', 'c'), ('м', 'v'), ('и', 'b'),
    ('т', 'n'), ('ь', 'm'),
    // Symbol keys (lowercase Cyrillic on symbol key positions)
    ('ж', ';'), ('э', '\''), ('х', '['), ('ъ', ']'),
    ('ё', '`'), ('б', ','), ('ю', '.'),
    // Uppercase letters: Cyrillic -> Latin uppercase
    ('Й', 'Q'), ('Ц', 'W'), ('У', 'E'), ('К', 'R'), ('Е', 'T'),
    ('Н', 'Y'), ('Г', 'U'), ('Ш', 'I'), ('Щ', 'O'), ('З', 'P'),
    ('Ф', 'A'), ('Ы', 'S'), ('В', 'D'), ('А', 'F'), ('П', 'G'),
    ('Р', 'H'), ('О', 'J'), ('Л', 'K'), ('Д', 'L'),
    ('Я', 'Z'), ('Ч', 'X'), ('С', 'C'), ('М', 'V'), ('И', 'B'),
    ('Т', 'N'), ('Ь', 'M'),
    // Shifted symbol keys (uppercase Cyrillic on shifted symbol positions)
    ('Ж', ':'), ('Э', '"'), ('Х', '{'), ('Ъ', '}'),
    ('Ё', '~'), ('Б', '<'), ('Ю', '>'),
];

/// Normalize a character from a non-Latin (Russian) layout to its Latin
/// physical-key equivalent. Returns `None` when the character is not in
/// the Russian layout map.
#[must_use]
pub fn normalize_cyrillic_char(c: char) -> Option<char> {
    RU_LAYOUT_MAP
        .iter()
        .find(|(cyrillic, _)| *cyrillic == c)
        .map(|(_, latin)| *latin)
}


#[cfg(test)]
mod tests {
    use super::normalize_cyrillic_char;

    #[test]
    fn lowercase_cyrillic_maps_to_latin() {
        assert_eq!(normalize_cyrillic_char('й'), Some('q'));
        assert_eq!(normalize_cyrillic_char('ц'), Some('w'));
        assert_eq!(normalize_cyrillic_char('щ'), Some('o'));
        assert_eq!(normalize_cyrillic_char('ь'), Some('m'));
        assert_eq!(normalize_cyrillic_char('ё'), Some('`'));
        assert_eq!(normalize_cyrillic_char('ю'), Some('.'));
    }

    #[test]
    fn uppercase_cyrillic_maps_to_latin_uppercase() {
        assert_eq!(normalize_cyrillic_char('Й'), Some('Q'));
        assert_eq!(normalize_cyrillic_char('Щ'), Some('O'));
        assert_eq!(normalize_cyrillic_char('Ь'), Some('M'));
        assert_eq!(normalize_cyrillic_char('Ё'), Some('~'));
        assert_eq!(normalize_cyrillic_char('Ю'), Some('>'));
    }

    #[test]
    fn latin_chars_pass_through_as_none() {
        assert_eq!(normalize_cyrillic_char('a'), None);
        assert_eq!(normalize_cyrillic_char('Z'), None);
        assert_eq!(normalize_cyrillic_char(';'), None);
    }
}
