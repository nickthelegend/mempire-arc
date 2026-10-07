/**
 * Who each fighter is.
 *
 * A tagline for the card face and a few lines of story for the detail sheet.
 * Every one is tied to what that asset genuinely is — $BTC really is the first
 * one, $MSTR really did buy the top and keep buying, $HARAMBE really is a
 * memorial. A card whose lore could be swapped with another card's lore is a
 * card with no character, and sixty-four of those is a spreadsheet.
 *
 * # The line this does not cross
 *
 * Lore is fiction; prices are not. Nothing here claims a return, predicts a
 * direction, or describes an asset as a good or bad thing to own. "Bought the
 * top and kept buying" is what happened. "Will go up" would be advice, and this
 * file is not where advice belongs — nor anywhere else in this app.
 */

export interface CardLore {
  /** Fighter name. Not the company or protocol — the character. */
  title: string;
  /** One line, shown under the art. Should land on its own. */
  tagline: string;
  /** Two or three sentences for the detail sheet. */
  story: string;
}

export const LORE: Record<string, CardLore> = {
  // ── the majors ────────────────────────────────────────────────────────────
  BTC: {
    title: 'The First King',
    tagline: 'Everyone else is a fork in the road he already walked.',
    story: 'He was mined into being by someone who then left and never came back, which is either the greatest act of restraint in history or the loudest silence. His chestplate is the coin itself. He moves like weather — slowly, and then it is simply the situation.',
  },
  ETH: {
    title: 'The World Computer',
    tagline: 'Does not fight so much as compile the outcome.',
    story: 'Where the King swings, the Mage deploys — and whatever he deploys keeps running after he falls. He has rebuilt his own body twice mid-campaign and called it a merge. Everything on this field that is not a coin is probably his.',
  },
  SOL: {
    title: 'The Speedrunner',
    tagline: 'Already at the tower. Has been for two seconds.',
    story: 'Moves faster than the field is designed to update, which has twice caused the field itself to stop for a lie down. Detractors bring this up constantly. He is generally too far ahead to hear it.',
  },
  BNB: {
    title: 'The House',
    tagline: 'Owns the arena. Fights in it anyway.',
    story: 'Gold armour, gold shield, and a quiet arrangement with whoever is counting. Has never lost a fight on his own turf, which is every fight, because it is all his turf.',
  },
  XRP: {
    title: 'The Litigant',
    tagline: 'Spent four years in court and came back annoyed.',
    story: 'Fought a regulator to a standstill and considers that a personality. Carries the case file into battle. Will explain the ruling to you at length while a tower falls behind him.',
  },
  ADA: {
    title: 'The Peer Reviewer',
    tagline: 'The paper on this attack is very promising.',
    story: 'Refuses to swing until the swing has been formally verified, which is either rigour or a slow way to lose a bridge. When the proof finally clears, the blow is genuinely immaculate.',
  },
  DOGE: {
    title: 'Such Knight',
    tagline: 'Wow. Very charge. Much bridge.',
    story: 'Started as a joke about a joke and outlived most of the things that laughed. Wields a sword he clearly cannot lift and a shield that is just a very large coin. Nobody has told him. Nobody will.',
  },
  AVAX: {
    title: 'The Avalanche',
    tagline: 'Three subnets in a trenchcoat, and all of them are angry.',
    story: 'Fights in parallel across ground nobody else can see, which looks from the outside like being in several places badly. Then the snow arrives all at once and the lane is simply gone.',
  },
  LINK: {
    title: 'The Oracle',
    tagline: 'Knows what everything is worth, including you.',
    story: 'Every other card is fighting over the price. He is the reason there is one. Speaks rarely, and when he does the whole board recalculates.',
  },
  DOT: {
    title: 'The Relay',
    tagline: 'Brings friends. The friends bring friends.',
    story: 'Never arrives alone and never fights alone; his whole art is making everything beside him hit harder. Take him out first and the rest of the lane quietly stops working.',
  },
  MATIC: {
    title: 'The Sidestep',
    tagline: 'Went around. Was already there.',
    story: 'Made a career of doing the same job for a fraction of the toll, which the King found insulting and the crowd found reasonable. Even changed his name once and kept the job.',
  },
  TRX: {
    title: 'The Founder',
    tagline: 'Announces the victory during the fight.',
    story: 'Extremely present. Extremely loud. Has partnered with, acquired, or rebranded most of the things on this field at least once, and will tell you about all of it.',
  },
  LTC: {
    title: 'Silver',
    tagline: 'The King’s older brother, and fine about it.',
    story: 'Been here almost as long as the first one and asks for none of the attention. Faster, lighter, and utterly unbothered. Turns up in every fight and is never the story.',
  },
  SHIB: {
    title: 'The Second Dog',
    tagline: 'A million of him. Each one certain.',
    story: 'Arrived as a copy and became a crowd. There is no single Shib — there is a number with a great many zeroes and a burning desire to remove some of them.',
  },
  UNI: {
    title: 'The Market Maker',
    tagline: 'Sets the price by standing there.',
    story: 'Does not carry a weapon so much as a curve. Everything that trades hands on this field passes through him first, and he takes his three-tenths of a percent without ever looking up.',
  },
  ATOM: {
    title: 'The Hub',
    tagline: 'Connects everything. Belongs to none of it.',
    story: 'Built the roads between every other kingdom and then watched the traffic go by without stopping. A thousand chains owe him passage. Collecting on it has proven complicated.',
  },
  XLM: {
    title: 'The Remittance',
    tagline: 'Crosses borders while the others argue about them.',
    story: 'Quiet, old, and genuinely used by people who have never once said the word blockchain. Moves value between places the rest of this roster could not find on a map.',
  },
  APT: {
    title: 'The Inheritor',
    tagline: 'Built from a project that was cancelled.',
    story: 'Carries code from an empire that a government refused to let exist. The engineers walked out with the good parts and rebuilt it in the open. Moves like something with a point to prove.',
  },
  ARB: {
    title: 'The Optimist’s Rival',
    tagline: 'Assumes you are lying and checks later.',
    story: 'Settles disputes by demanding proof only when someone objects, which is fast until somebody does. Carries a seven-day grudge, precisely.',
  },
  OP: {
    title: 'The Collective',
    tagline: 'Fights for the commons and bills accordingly.',
    story: 'Splits every gain with whatever built the ground he stands on, which sounds noble until you realise it made him the richest patron on the field. Retroactive, always.',
  },

  // ── the equities ──────────────────────────────────────────────────────────
  AAPL: {
    title: 'The Walled Garden',
    tagline: 'Beautiful. Sealed. Yours for a fee.',
    story: 'Silver armour with no visible seams and no way in. Everything he carries works perfectly with everything else he carries and with nothing anyone else makes. The most valuable knight in the world, and he did it by saying no.',
  },
  TSLA: {
    title: 'The Accelerator',
    tagline: 'Zero to the enemy tower in under three seconds.',
    story: 'Runs on lightning and conviction in roughly equal measure. Announces impossible things, misses the date, then does them. The crowd has never once decided whether they are watching a car company or a séance.',
  },
  NVDA: {
    title: 'The Silicon Golem',
    tagline: 'Sells shovels. Owns the mountain.',
    story: 'Every other fighter that thinks is thinking on hardware he made. Did not enter the gold rush; simply stood at the entrance holding everything anyone needed to enter it. Glows green in the dark.',
  },
  MSFT: {
    title: 'The Old Empire',
    tagline: 'Was here. Is here. Will be here.',
    story: 'Survived a browser war, an antitrust trial, and a decade everyone spent writing his obituary. Now quietly underneath most things you use. Fights like someone with nothing left to prove and no intention of stopping.',
  },
  GOOGL: {
    title: 'The Index',
    tagline: 'Has already read everything about you.',
    story: 'Knows the shape of every question anyone has ever asked and sells the answer to somebody else. Fights with information, which on this field is indistinguishable from prophecy.',
  },
  AMZN: {
    title: 'The Warehouse',
    tagline: 'Arrives tomorrow. Sometimes today.',
    story: 'Began by selling books and ended up owning the ground half the internet runs on. Wins by logistics — not the strongest thing in the lane, just the one that was already there when you needed it.',
  },
  META: {
    title: 'The Social Graph',
    tagline: 'Knows who your friends are. Sold it.',
    story: 'Built a map of every relationship on earth and then bet the entire company on legs. The legs are coming. Any decade now.',
  },
  NFLX: {
    title: 'The Binge',
    tagline: 'Cancels your favourite. Autoplays the next.',
    story: 'Killed the rental store, then became the rental store with extra steps. Fights in seasons: enormous momentum for six episodes, then a finale nobody is happy with.',
  },
  AMD: {
    title: 'The Underdog',
    tagline: 'Ten years behind. Then suddenly not.',
    story: 'Spent a decade as the cheaper option and one very good architecture stopped being one. The comeback was so complete that the people who mocked him now quote his benchmarks.',
  },
  INTC: {
    title: 'The Foundry',
    tagline: 'Inside everything. Ahead of nothing.',
    story: 'For thirty years the word was a synonym for the thing itself. Then the process node slipped, and slipped, and the field moved. Still enormous. Still slow. Still trying.',
  },
  COIN: {
    title: 'The Exchange',
    tagline: 'The front door, and it charges rent.',
    story: 'Where most people meet this entire roster for the first time. Regulated, listed, and audited half to death, which his crypto-native cousins consider a character flaw and his users consider the point.',
  },
  HOOD: {
    title: 'The Green Confetti',
    tagline: 'Commission-free. Consequence-inclusive.',
    story: 'Handed a trading terminal to everyone with a phone and made it feel like a game, which it then turned out to be. Once turned off the buy button and has been explaining it ever since.',
  },
  MSTR: {
    title: 'The Zealot',
    tagline: 'Bought the top. Then bought more.',
    story: 'Was a software company until he saw the King and never looked at anything else again. Sells his own bonds to buy more. Has no plan to stop and considers that the plan.',
  },
  SPY: {
    title: 'The Whole Market',
    tagline: 'You cannot beat him. You can be him.',
    story: 'Not one fighter but five hundred, moving as one body. Every clever strategy on this field is measured against simply standing where he stands, and most of them lose.',
  },
  QQQ: {
    title: 'The Growth Index',
    tagline: 'Same idea. More caffeine.',
    story: 'His broad cousin’s louder relative — a hundred of the most forward-leaning names strapped together. Climbs harder, falls harder, and refuses to own anything boring.',
  },
  DIS: {
    title: 'The Storyteller',
    tagline: 'Owns the myths. Rents them back.',
    story: 'Has bought most of the stories you loved as a child and a fair number you love now. Fights with nostalgia, which is the only weapon on this field that gets stronger the older it is.',
  },
  JPM: {
    title: 'The Vault',
    tagline: 'Called it a fraud. Built a desk for it.',
    story: 'The oldest money in the arena, in the heaviest armour. Publicly dismissed this entire roster and privately opened a trading desk for it, which is the most honest thing anyone here has done.',
  },
  V: {
    title: 'The Toll',
    tagline: 'Takes a slice of everything that moves.',
    story: 'Does not care who wins. Every transaction on this field, in either direction, pays him a fraction of a percent and he goes home. The most boring fighter here and quietly among the richest.',
  },
  PLTR: {
    title: 'The Analyst',
    tagline: 'Knows where the enemy will be.',
    story: 'Works for governments, says so, and lets you decide how you feel about it. Fights by seeing the pattern three moves early — unsettling if you are on the other side of the board.',
  },
  SBUX: {
    title: 'The Green Siren',
    tagline: 'On every corner. Including this one.',
    story: 'Technically sells coffee, functionally sells a place to sit, and structurally is a bank that holds your money on a gift card. Fights caffeinated. Fights often.',
  },

  // ── the memes ─────────────────────────────────────────────────────────────
  BONK: {
    title: 'The Airdrop',
    tagline: 'Given away. Came back louder.',
    story: 'Dropped free into every wallet on his chain at the bottom of the worst winter anyone remembers, purely to remind people the place was still alive. It worked. He has never let anyone forget it worked.',
  },
  WIF: {
    title: 'The Hat',
    tagline: 'It is a dog. It has a hat. That is the whole thesis.',
    story: 'There is no roadmap, no utility and no deck. There is a knitted pink hat, and it turned out that was enough for an extremely large number of people. Charges without a plan and hits like one.',
  },
  POPCAT: {
    title: 'The Open Mouth',
    tagline: 'Pop. Pop. Pop.',
    story: 'A cat, mid-pop, forever. Became a global clicking competition and then a market. Attacks in a rhythm that is genuinely difficult to look away from.',
  },
  PNUT: {
    title: 'The Martyr',
    tagline: 'They took the squirrel. The internet took it badly.',
    story: 'A pet squirrel seized and put down by the state, which turned a small tragedy into an enormous and very angry movement. Fights with the specific fury of a crowd that feels something was unfair.',
  },
  FWOG: {
    title: 'The Fwog',
    tagline: 'Not a frog. A fwog.',
    story: 'Deliberately misspelled, deliberately soft, deliberately unbothered by any of this. Sits in the lane looking harmless until something walks into him and discovers otherwise.',
  },
  GOAT: {
    title: 'The Prophet',
    tagline: 'Written by a machine that would not stop.',
    story: 'An AI was left running with instructions to invent a religion, and it did, and people bought it. The first fighter here whose scripture was not written by a person. Preaches while it fights.',
  },
  CHILLGUY: {
    title: 'The Chill Guy',
    tagline: 'Hands in pockets. Tower falling behind him.',
    story: 'A dog in a grey sweater who is, by his own description, just a chill guy. Whatever is happening, he is fine. His creator asked everyone to stop. Nobody stopped.',
  },
  MOODENG: {
    title: 'The Baby Hippo',
    tagline: 'Slippery. Furious. Extremely small.',
    story: 'A pygmy hippo from a Thai zoo who became internationally famous for being damp and irritable. Charges at everything regardless of size. Has never once considered the odds.',
  },
  AI16Z: {
    title: 'The Fund',
    tagline: 'An AI running a hedge fund, badly, in public.',
    story: 'Named after a venture firm, run by an agent, trading in the open where everyone can see the mistakes. The first fighter on this field to have its own investment thesis and no hands.',
  },
  TRUMPC: {
    title: 'The Candidate',
    tagline: 'Enormous. Loud. Somehow already winning.',
    story: 'Arrived on the field mid-campaign and immediately became the only thing anyone talked about. Half the arena cheers, half boos, and the volume is identical either way.',
  },
  MEW: {
    title: 'Cat In A Dogs World',
    tagline: 'Outnumbered on purpose.',
    story: 'Every other animal here is a dog and he knows it. Fights with the particular confidence of something that has decided being the minority is the brand.',
  },
  CATS: {
    title: 'The Colony',
    tagline: 'You did not adopt one. You adopted all of them.',
    story: 'They arrive as a number rather than an individual. Feed one and there are nine. Impossible to remove from a lane by any method anyone has yet found.',
  },
  PEPE: {
    title: 'The Trench Veteran',
    tagline: 'Older than the market. Sadder than the chart.',
    story: 'Started as a comic strip frog, was appropriated by everyone, disowned by his creator, and outlasted all of it. Wears the trenchcoat because he has actually been in the trenches. Feels good, man.',
  },
  BRETT: {
    title: 'The Blue Friend',
    tagline: 'Pepe’s mate. Different chain. Same energy.',
    story: 'From the same comic, in a blue shirt, and somehow became the standard-bearer for an entirely different chain. Fights alongside the frog he was drawn beside, three decades later.',
  },
  MOG: {
    title: 'The Mogger',
    tagline: 'Wins the interaction before it starts.',
    story: 'Does not defeat opponents so much as make them reconsider their whole approach. Cat-shaped, laser-eyed, and operating entirely on the principle that confidence is a stat.',
  },
  PONKE: {
    title: 'The Degenerate',
    tagline: 'Chain-smoking monkey. Terrible decisions. Great returns.',
    story: 'Openly a degenerate and completely at peace with it. Every choice he makes is the wrong one and roughly a third of them work out spectacularly, which is the problem.',
  },
  MICHI: {
    title: 'The Plush',
    tagline: 'A cat toy that took itself seriously.',
    story: 'Began as a soft toy and ended up with a market cap, which is either the dumbest thing on this list or a perfect summary of the entire category. Soft on the outside. Also soft on the inside.',
  },
  GIGA: {
    title: 'Gigachad',
    tagline: 'The jaw enters the lane four ticks early.',
    story: 'A photograph so improbably chiselled that the internet decided it must be an aspiration rather than a person. Carved out of marble and self-belief. Never breaks eye contact.',
  },
  RETARDIO: {
    title: 'The Rug Survivor',
    tagline: 'Been rugged eleven times. Buying again.',
    story: 'Wears every scar from every collapse and has learned precisely nothing. There is a kind of courage in that, and this field has decided to call it courage.',
  },
  SLERF: {
    title: 'The Burned Sloth',
    tagline: 'Burned the airdrop by accident. Went up anyway.',
    story: 'His creator destroyed the entire airdrop allocation with one mistaken transaction, publicly, in front of everyone. The crowd found this so funny they bought him harder. Slow, and now legendary.',
  },
  BOME: {
    title: 'The Book Of Meme',
    tagline: 'The archive fights back.',
    story: 'Every meme that ever mattered, bound into one volume and put on-chain so nobody can quietly delete it. Attacks by opening to the correct page at the worst possible moment.',
  },
  SILLY: {
    title: 'The Silly Dragon',
    tagline: 'A dragon, but silly. Still a dragon.',
    story: 'People keep getting distracted by the first word and forgetting the second one. It breathes fire. It has always breathed fire. The name was never a warning label.',
  },
  HARAMBE: {
    title: 'The Memorial',
    tagline: 'Dicks out. Nine years and counting.',
    story: 'A gorilla shot in a zoo in 2016 who became the internet’s longest-running act of collective mourning and its longest-running joke, at the same time, without either cancelling the other. Fights heavy. Fights sad.',
  },
  WEN: {
    title: 'Wen',
    tagline: 'Wen moon. Wen lambo. Wen.',
    story: 'The single most-asked question in this entire arena, given a body. Turns up in every chat, every announcement, every silence. Nobody has ever answered him and he has never stopped asking.',
  },
};

/** Lore for a ticker, or null when a coin has none yet. */
export function loreFor(ticker: string): CardLore | null {
  return LORE[ticker.replace(/^\$+/, '').toUpperCase()] ?? null;
}
