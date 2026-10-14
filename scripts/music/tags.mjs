// The words a track can be found by: its genre, its mood and its instruments.
// Scenario makers narrow the hub's music list down by them in the game, to
// find the tracks their scenario needs.
//
// The lists are the ones Scott Buckley's library sorts its tracks by (the
// genre, mood and instrumentation menus of www.scottbuckley.com.au/library),
// where most of the hub's music comes from, so a track posted from there keeps
// the composer's own sorting, and anyone else's track is sorted the same way.
// Three of the site's names are folded: its mood "Somber" is "Sombre", its
// instrument "Orchestral" is "Orchestra", and "mandolin" is "Mandolin".
//
// The form (.github/ISSUE_TEMPLATE/music.yml) offers exactly these, in this
// order: keep the two in step.

export const GENRES = Object.freeze([
  "Ambient",
  "Christmas",
  "Electronica",
  "Folk",
  "Funk",
  "Halloween",
  "Hip Hop",
  "Jazz",
  "Neoclassical",
  "Noir",
  "Orchestral",
  "Pop",
  "Rock",
  "Techno",
]);

export const MOODS = Object.freeze([
  "Adventurous",
  "Angry",
  "Bittersweet",
  "Blissful",
  "Brooding",
  "Calm",
  "Christmas",
  "Comedic",
  "Cute",
  "Dark",
  "Depressed",
  "Dreamy",
  "Driving",
  "Emotional",
  "Energetic",
  "Epic",
  "Excited",
  "Fun",
  "Grandiose",
  "Happy",
  "Heroic",
  "Hopeful",
  "Industrial",
  "Innocent",
  "Inspirational",
  "Intense",
  "Lonely",
  "Meditative",
  "Melancholy",
  "Militaristic",
  "Mysterious",
  "Nostalgic",
  "Ominous",
  "Passionate",
  "Peaceful",
  "Playful",
  "Reflective",
  "Relaxed",
  "Romantic",
  "Sad",
  "Sinister",
  "Sleepy",
  "Sombre",
  "Spiritual",
  "Thoughtful",
  "Uplifting",
]);

export const INSTRUMENTS = Object.freeze([
  "Accordion",
  "Bass",
  "Bass (Acoustic)",
  "Brass",
  "Cello",
  "Choir",
  "Clarinet",
  "Drums (Acoustic)",
  "Drums (Electronic)",
  "Drums (Epic)",
  "Flute (Ethnic)",
  "Glockenspiel",
  "Guitar (Acoustic)",
  "Guitar (Electric)",
  "Harp",
  "Mandolin",
  "Orchestra",
  "Organ",
  "Percussion",
  "Piano",
  "Piano (Electric)",
  "Recorder",
  "Saxophone",
  "Strings",
  "Synth (Atmospherics)",
  "Synth (Lead)",
  "Synth (Pad)",
  "Trumpet",
  "Ukulele",
  "Vibes",
  "Violin",
  "Vocals (Female)",
  "Vocals (Male)",
  "Woodwinds",
  "Xylophone",
]);

// The library's own words for them, as its posts carry them in their classes
// ("genre-pop-2", "mood-bittersweet", "instrumentation-synth-pad"): the part
// after the dash, and the name above it stands for.
export const SITE_TERMS = Object.freeze({
  genre: Object.freeze({
    "ambient": "Ambient",
    "christmas": "Christmas",
    "electronica-2": "Electronica",
    "folk": "Folk",
    "funk": "Funk",
    "halloween": "Halloween",
    "hip-hop": "Hip Hop",
    "jazz": "Jazz",
    "neoclassical": "Neoclassical",
    "noir": "Noir",
    "orchestral": "Orchestral",
    "pop-2": "Pop",
    "rock-2": "Rock",
    "techno": "Techno",
  }),
  mood: Object.freeze({
    "adventurous": "Adventurous",
    "angry": "Angry",
    "bittersweet": "Bittersweet",
    "blissful": "Blissful",
    "brooding": "Brooding",
    "calm": "Calm",
    "christmas": "Christmas",
    "comedic": "Comedic",
    "cute": "Cute",
    "dark": "Dark",
    "depressed": "Depressed",
    "dreamy": "Dreamy",
    "driving": "Driving",
    "emotional": "Emotional",
    "energetic": "Energetic",
    "epic": "Epic",
    "excited": "Excited",
    "fun": "Fun",
    "grandiose": "Grandiose",
    "happy": "Happy",
    "heroic": "Heroic",
    "hopeful": "Hopeful",
    "industrial": "Industrial",
    "innocent": "Innocent",
    "inspirational": "Inspirational",
    "intense": "Intense",
    "lonely": "Lonely",
    "meditative": "Meditative",
    "melancholy": "Melancholy",
    "militaristic": "Militaristic",
    "mysterious": "Mysterious",
    "nostalgic": "Nostalgic",
    "ominous": "Ominous",
    "passionate": "Passionate",
    "peaceful": "Peaceful",
    "playful": "Playful",
    "reflective": "Reflective",
    "relaxed": "Relaxed",
    "romantic": "Romantic",
    "sad": "Sad",
    "sinister": "Sinister",
    "sleepy": "Sleepy",
    "somber": "Sombre",
    "sombre": "Sombre",
    "spiritual": "Spiritual",
    "thoughtful": "Thoughtful",
    "uplifting": "Uplifting",
  }),
  instrumentation: Object.freeze({
    "accordion": "Accordion",
    "bass": "Bass",
    "bass-acoustic": "Bass (Acoustic)",
    "brass": "Brass",
    "cello": "Cello",
    "choir": "Choir",
    "clarinet": "Clarinet",
    "drums-acoustic": "Drums (Acoustic)",
    "drums-electronic": "Drums (Electronic)",
    "drums-epic": "Drums (Epic)",
    "flute-ethnic": "Flute (Ethnic)",
    "glockenspiel": "Glockenspiel",
    "guitar-acoustic": "Guitar (Acoustic)",
    "guitar-electric": "Guitar (Electric)",
    "harp": "Harp",
    "mandolin": "Mandolin",
    "orchestra": "Orchestra",
    "orchestral": "Orchestra",
    "organ": "Organ",
    "percussion": "Percussion",
    "piano": "Piano",
    "piano-electric": "Piano (Electric)",
    "recorder": "Recorder",
    "saxophone": "Saxophone",
    "strings": "Strings",
    "synth-atmospherics": "Synth (Atmospherics)",
    "synth-lead": "Synth (Lead)",
    "synth-pad": "Synth (Pad)",
    "trumpet": "Trumpet",
    "ukulele": "Ukulele",
    "vibes": "Vibes",
    "violin": "Violin",
    "vocals-female": "Vocals (Female)",
    "vocals-male": "Vocals (Male)",
    "woodwinds": "Woodwinds",
    "xylophone": "Xylophone",
  }),
});

// An answer to one of the form's three lists, as GitHub writes a choice of
// several ("Orchestral, Epic"; "" or "_No response_" for none): { tags,
// unknown }. `tags` are the list's own names, in the list's order, however
// they were written; `unknown` is whatever named none of them.
export const tagsOf = (answer, names) => {
  const wanted = new Map(names.map((name) => [name.toLowerCase(), name]));
  const chosen = new Set();
  const unknown = [];
  const text = String(answer ?? "").trim();
  if (!text || text === "_No response_") return { tags: [], unknown };
  for (const part of text.split(/\s*[,\n]\s*/)) {
    const word = part.replace(/^[-*]\s*/, "").trim();
    if (!word) continue;
    const name = wanted.get(word.toLowerCase());
    if (name) chosen.add(name);
    else unknown.push(word);
  }
  return { tags: names.filter((name) => chosen.has(name)), unknown };
};

// A library post's classes → { genres, moods, instruments }, each in its
// list's order, and `unknown`: the classes that name a genre, mood or
// instrument these lists do not know (the composer has added one since).
export const siteTagsOf = (classes) => {
  const found = { genre: new Set(), mood: new Set(), instrumentation: new Set() };
  const unknown = [];
  for (const entry of Array.isArray(classes) ? classes : []) {
    const match = /^(genre|mood|instrumentation)-(.+)$/.exec(String(entry));
    if (!match) continue;
    const name = SITE_TERMS[match[1]][match[2]];
    if (name) found[match[1]].add(name);
    else unknown.push(String(entry));
  }
  return {
    genres: GENRES.filter((name) => found.genre.has(name)),
    moods: MOODS.filter((name) => found.mood.has(name)),
    instruments: INSTRUMENTS.filter((name) => found.instrumentation.has(name)),
    unknown,
  };
};
