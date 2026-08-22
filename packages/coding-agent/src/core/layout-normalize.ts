/**
 * Russian keyboard layout: Cyrillic codepoint -> Latin codepoint on the same physical key.
 * Used to normalize Kitty CSI-u and xterm modifyOtherKeys sequences so keybindings match
 * regardless of the active keyboard layout.
 *
 * When Kitty keyboard protocol is active but the terminal does not send baseLayoutKey
 * (e.g. VS Code's xterm.js without Shift), the CSI-u codepoint is the Cyrillic character
 * (e.g. щ=1097), not the Latin one (o=111). This mapping bridges that gap.
 */
const RU_LAYOUT_MAP: ReadonlyMap<number, number> = new Map([
	// Lowercase letters: Cyrillic -> Latin (same physical key)
	[1081, 113], // й -> q
	[1094, 119], // ц -> w
	[1091, 101], // у -> e
	[1082, 114], // к -> r
	[1077, 116], // е -> t
	[1085, 121], // н -> y
	[1075, 117], // г -> u
	[1096, 105], // ш -> i
	[1097, 111], // щ -> o
	[1079, 112], // з -> p
	[1092, 97], // ф -> a
	[1099, 115], // ы -> s
	[1074, 100], // в -> d
	[1072, 102], // а -> f
	[1087, 103], // п -> g
	[1088, 104], // р -> h
	[1086, 106], // о -> j
	[1083, 107], // л -> k
	[1076, 108], // д -> l
	[1103, 122], // я -> z
	[1095, 120], // ч -> x
	[1089, 99], // с -> c
	[1084, 118], // м -> v
	[1080, 98], // и -> b
	[1090, 110], // т -> n
	[1100, 109], // ь -> m
	// Symbol keys (lowercase Cyrillic on symbol key positions)
	[1078, 59], // ж -> ;
	[1101, 39], // э -> '
	[1093, 91], // х -> [
	[1098, 93], // ъ -> ]
	[1105, 96], // ё -> `
	[1073, 44], // б -> ,
	[1102, 46], // ю -> .
	// Uppercase letters: Cyrillic -> Latin uppercase
	[1049, 81], // Й -> Q
	[1062, 87], // Ц -> W
	[1059, 69], // У -> E
	[1050, 82], // К -> R
	[1045, 84], // Е -> T
	[1053, 89], // Н -> Y
	[1043, 85], // Г -> U
	[1064, 73], // Ш -> I
	[1065, 79], // Щ -> O
	[1047, 80], // З -> P
	[1060, 65], // Ф -> A
	[1067, 83], // Ы -> S
	[1042, 68], // В -> D
	[1040, 70], // А -> F
	[1055, 71], // П -> G
	[1056, 72], // Р -> H
	[1054, 74], // О -> J
	[1051, 75], // Л -> K
	[1044, 76], // Д -> L
	[1071, 90], // Я -> Z
	[1063, 88], // Ч -> X
	[1057, 67], // С -> C
	[1052, 86], // М -> V
	[1048, 66], // И -> B
	[1058, 78], // Т -> N
	[1068, 77], // Ь -> M
	// Shifted symbol keys (uppercase Cyrillic on shifted symbol positions)
	[1046, 58], // Ж -> :
	[1069, 34], // Э -> "
	[1061, 123], // Х -> {
	[1066, 125], // Ъ -> }
	[1025, 126], // Ё -> ~
	[1041, 60], // Б -> <
	[1070, 62], // Ю -> >
]);

// Kitty CSI-u regex: ESC [ codepoint [:shifted [:base]] [;modifier [:event]] u
const KITTY_CSI_U = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/;

// xterm modifyOtherKeys regex: ESC [ 27 ; modifier ; codepoint ~
const MOD_OTHER_KEYS = /^\x1b\[27;(\d+);(\d+)~$/;

/**
 * Normalize keyboard input for non-Latin layouts.
 * Maps Cyrillic codepoints to their Latin physical-key equivalents in
 * Kitty CSI-u and xterm modifyOtherKeys sequences so keybindings match.
 * Only applies when a modifier key is active (ctrl, alt, shift, etc.).
 * Plain text input is passed through unchanged.
 */
export function normalizeLayoutInput(data: string): string {
	if (data.length < 4 || !data.startsWith("\x1b[")) return data;

	// Kitty CSI-u format
	const kittyMatch = data.match(KITTY_CSI_U);
	if (kittyMatch) {
		const codepoint = Number.parseInt(kittyMatch[1]!, 10);
		const shiftedKey = kittyMatch[2];
		const baseLayoutKey = kittyMatch[3];
		const modifierStr = kittyMatch[4];
		const eventStr = kittyMatch[5];
		const modifier = modifierStr ? Number.parseInt(modifierStr, 10) : 1;

		// Only normalize when a modifier is active (1 = none, >1 = some modifier)
		if (modifier <= 1) return data;

		// Skip if baseLayoutKey is present (terminal already provides the physical key)
		if (baseLayoutKey !== undefined) return data;

		const latinCp = RU_LAYOUT_MAP.get(codepoint);
		if (latinCp === undefined) return data;

		let seq = `\x1b[${latinCp}`;
		if (shiftedKey !== undefined) seq += `:${shiftedKey}`;
		if (modifierStr !== undefined) seq += `;${modifierStr}`;
		if (eventStr !== undefined) seq += `:${eventStr}`;
		seq += "u";
		return seq;
	}

	// xterm modifyOtherKeys format
	const mokMatch = data.match(MOD_OTHER_KEYS);
	if (mokMatch) {
		const modifier = Number.parseInt(mokMatch[1]!, 10);
		const codepoint = Number.parseInt(mokMatch[2]!, 10);

		// Only normalize when a modifier is active (1 = none, >1 = some modifier)
		if (modifier <= 1) return data;

		const latinCp = RU_LAYOUT_MAP.get(codepoint);
		if (latinCp === undefined) return data;

		return `\x1b[27;${modifier};${latinCp}~`;
	}

	return data;
}
