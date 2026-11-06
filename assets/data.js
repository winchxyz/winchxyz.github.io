/* Shared content for the three concepts. Same words as the GitHub profile
   (winchxyz-profile/tools/projects.json); screenshots are the 720x450 shots
   from winchxyz-profile/assets/p, copied into ./p. */

export const STATS = [
  [37, 'open-source repos'],
  [27, 'live in the browser'],
  [479, 'stars on GitHub'],
];

export const LINE = 'I build tools, apps, games and films with Claude Code.';

export const SECTIONS = [
  { id: 'tools', title: 'AI tools', line: 'What I use every day to build with Claude Code and agents.',
    ids: ['loupe', 'crunch-time', 'idea-to-build', 'motion-studio', 'hermes-phone', 'x-ghostwriter'] },
  { id: 'games', title: 'Games', line: 'Browser games. Most have no asset files: every mesh, texture and sound is made in code.',
    ids: ['crayon-contraptions', 'vesper-street', 'moon-rover', 'celadon', 'tidewright', 'wumpus-torture-simulator'] },
  { id: 'apps', title: 'Photo and art apps', line: 'Turn a photo into something else. Everything runs in your browser, nothing is uploaded.',
    ids: ['mosaiz', 'spiralist', 'typist', 'platen', 'seedplot', 'credits-cubed'] },
  { id: 'graphics', title: 'Graphics and video', line: 'Real-time rendering experiments and short films where every frame is code.',
    ids: ['navis', 'aetherflow', 'endless-fishing', 'motion-reels', 'ant-farm', 'cut'] },
  { id: 'x', title: 'X and agents', line: 'Small helpers for posting, cleaning up and talking on calls. They never act without you.',
    ids: ['follower-sweep', 'draft-desk', 'hermes-ghost-call'] },
  { id: 'more', title: 'More', line: 'Side quests.',
    ids: ['mc-print-3d', 'zodiac-z13-z32', 'pudgy-torture-simulator'] },
];

/* prompt: the one-sentence brief the project started from, used by concept B's terminal */
const P = {
  'loupe': { line: 'A local website builder for Windows. AI makes the site, you fix it by hand on the live page.', live: 'https://tryloupe.app/', label: 'Site',
    prompt: 'a website builder where I can fix the AI\'s page by hand' },
  'crunch-time': { line: 'Your Claude Code agents at work in a PS1-style office.', live: 'https://winchxyz.github.io/crunch-time/', label: 'Open',
    prompt: 'show my agents working in a low-poly office' },
  'idea-to-build': { line: 'A plugin that turns a raw idea into a plan you can build.', label: 'Code',
    prompt: 'turn a raw idea into a plan I can build' },
  'motion-studio': { line: 'One brief in, a finished motion video out. Every frame is code.', label: 'Code',
    prompt: 'one brief in, a finished motion video out' },
  'hermes-phone': { line: 'Hermes Agent makes the phone call for you and reports back.', label: 'Code', type: true,
    prompt: 'make the phone call for me and report back' },
  'x-ghostwriter': { line: 'Drafts X posts and replies in your voice. You press publish.', label: 'Code',
    prompt: 'draft X replies in my voice, I press publish' },
  'crayon-contraptions': { line: 'A Rube Goldberg puzzle game drawn in crayon. 100 levels, seven crayons with their own physics.', live: 'https://winchxyz.github.io/crayon-contraptions/', label: 'Play',
    prompt: 'a Rube Goldberg puzzle drawn in crayon' },
  'vesper-street': { line: 'Survival horror in a drowned voxel town.', live: 'https://winchxyz.github.io/vesper-street/', label: 'Play',
    prompt: 'survival horror in a drowned voxel town' },
  'moon-rover': { line: 'Drive a rover across the Moon.', live: 'https://winchxyz.github.io/moon-rover/', label: 'Play',
    prompt: 'drive a rover across the Moon' },
  'celadon': { line: 'A pottery game. Throw a pot on the wheel, mix the glaze chemistry, fire the kiln.', live: 'https://winchxyz.github.io/celadon/', label: 'Play',
    prompt: 'a pottery game: wheel, glaze chemistry, kiln' },
  'tidewright': { line: 'Sandcastles on a beach that runs on the GPU.', live: 'https://winchxyz.github.io/tidewright/', label: 'Play',
    prompt: 'sandcastles against a tide that runs on the GPU' },
  'wumpus-torture-simulator': { name: 'wumpus sim', line: 'A ragdoll sandbox with 25 tools.', live: 'https://winchxyz.github.io/wumpus-torture-simulator/', label: 'Play',
    prompt: 'a ragdoll sandbox with 25 tools' },
  'mosaiz': { line: 'Turn any photo into a real mosaic: 3D preview, build video and a numbered print kit.', live: 'https://winchxyz.github.io/mosaiz/', label: 'Open',
    prompt: 'turn a photo into a real mosaic I can build' },
  'spiralist': { line: 'A photo drawn with one continuous line.', live: 'https://winchxyz.github.io/spiralist/', label: 'Open',
    prompt: 'draw a photo with one continuous line' },
  'typist': { line: 'Photo to text art for Instagram, X and Telegram.', live: 'https://winchxyz.github.io/typist/', label: 'Open',
    prompt: 'photo to text art for every feed' },
  'platen': { line: 'A cozy 3D typewriter. Write, draw typewriter art, or get a guide for your machine.', live: 'https://winchxyz.github.io/platen/', label: 'Open',
    prompt: 'a cozy 3D typewriter that draws' },
  'seedplot': { line: 'Five art styles. Same seed, same picture.', live: 'https://winchxyz.github.io/seedplot/', label: 'Open',
    prompt: 'five art styles, same seed, same picture' },
  'credits-cubed': { line: 'A picture cube made from Credits.', live: 'https://winchxyz.github.io/credits-cubed/', label: 'Play',
    prompt: 'a picture cube made from Credits' },
  'navis': { line: 'A flooded Gothic cathedral rendered in real time, from one HTML file.', live: 'https://winchxyz.github.io/navis/', label: 'Open',
    prompt: 'a flooded Gothic cathedral in one HTML file' },
  'aetherflow': { line: 'A GPU fluid lab with caustics.', live: 'https://winchxyz.github.io/aetherflow/', label: 'Open',
    prompt: 'a GPU fluid lab with caustics' },
  'endless-fishing': { line: 'An ocean under tonight\'s real sky.', live: 'https://winchxyz.github.io/endless-fishing/', label: 'Play',
    prompt: 'an ocean under tonight\'s real sky' },
  'motion-reels': { line: 'Short motion videos made with AI and code.', live: 'https://winchxyz.github.io/motion-reels/', label: 'Watch',
    prompt: 'short motion films, every frame code' },
  'ant-farm': { line: 'An ant farm on a hand-written WebGL2 engine.', live: 'https://winchxyz.github.io/ant-farm/', label: 'Play',
    prompt: 'an ant farm on my own WebGL2 engine' },
  'cut': { line: 'Slice objects along your mouse path.', live: 'https://winchxyz.github.io/cut/', label: 'Play',
    prompt: 'slice objects along the mouse path' },
  'follower-sweep': { line: 'A Chrome extension that finds dead followers on X and marks them, within X\'s rules.', live: 'https://winchxyz.github.io/follower-sweep/', label: 'Open',
    prompt: 'find dead followers on X, within the rules' },
  'draft-desk': { line: 'An n8n pipeline: Grok researches, Claude drafts, Telegram asks you.', label: 'Code', type: true,
    prompt: 'Grok researches, Claude drafts, Telegram asks me' },
  'hermes-ghost-call': { name: 'ghost call', line: 'Hermes listens to your call and whispers hints only to you.', label: 'Code', type: true,
    prompt: 'whisper hints to me during a call' },
  'mc-print-3d': { line: 'Minecraft builds to multi-colour 3D prints.', label: 'Code',
    prompt: 'Minecraft builds to multi-colour 3D prints' },
  'zodiac-z13-z32': { name: 'zodiac z13 / z32', line: 'A reproducible attack on two unsolved ciphers.', live: 'https://winchxyz.github.io/zodiac-z13-z32/', label: 'Read',
    prompt: 'attack the two unsolved Zodiac ciphers' },
  'pudgy-torture-simulator': { name: 'pudgy sim', line: 'The same sandbox, with a penguin.', live: 'https://winchxyz.github.io/pudgy-torture-simulator/', label: 'Play',
    prompt: 'the same sandbox, with a penguin' },
};

export const PROJECTS = SECTIONS.flatMap(s => s.ids.map(id => {
  const p = P[id];
  return {
    id, section: s.id, sectionTitle: s.title,
    name: p.name || id,
    line: p.line, prompt: p.prompt,
    label: p.label,
    href: p.live || `https://github.com/winchxyz/${id}`,
    code: `https://github.com/winchxyz/${id}`,
    live: !!p.live,
    img: p.type ? null : new URL(`./p/${id}.jpg`, import.meta.url).href,
  };
}));

export const byId = Object.fromEntries(PROJECTS.map(p => [p.id, p]));

export const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
