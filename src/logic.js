// Logika murni game (tanpa Discord) supaya mudah dites.

const ROLES = {
  werewolf: {
    name: 'Werewolf',
    emoji: '🐺',
    team: 'wolf',
    desc: 'Tiap malam, bersama sesama Werewolf, pilih satu warga untuk dimangsa. Menang kalau jumlah Werewolf sama dengan atau lebih banyak dari warga.',
  },
  villager: {
    name: 'Warga',
    emoji: '🧑‍🌾',
    team: 'village',
    desc: 'Tidak punya kekuatan khusus. Cari tahu siapa Werewolf lewat diskusi dan gantung mereka saat voting.',
  },
  seer: {
    name: 'Seer',
    emoji: '🔮',
    team: 'village',
    desc: 'Tiap malam, terawang satu pemain untuk tahu apakah dia Werewolf atau bukan.',
  },
  doctor: {
    name: 'Dokter',
    emoji: '🩺',
    team: 'village',
    desc: 'Tiap malam, lindungi satu pemain (boleh dirimu sendiri) dari serangan Werewolf. Tidak boleh melindungi orang yang sama dua malam berturut-turut.',
  },
  hunter: {
    name: 'Pemburu',
    emoji: '🏹',
    team: 'village',
    desc: 'Kalau kamu mati (dimangsa atau digantung), kamu bisa menembak satu pemain untuk ikut mati bersamamu.',
  },
};

function shuffle(arr) {
  const r = [...arr];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

// Komposisi role berdasarkan jumlah pemain
function roleSet(n) {
  const wolves = Math.max(1, Math.floor(n / 4));
  const roles = Array(wolves).fill('werewolf');
  roles.push('seer');
  if (n >= 5) roles.push('doctor');
  if (n >= 8) roles.push('hunter');
  while (roles.length < n) roles.push('villager');
  return roles.slice(0, n);
}

// players: iterable of { role, alive }. Return 'village' | 'wolf' | null
function checkWin(players) {
  let wolves = 0;
  let others = 0;
  for (const p of players) {
    if (!p.alive) continue;
    if (p.role === 'werewolf') wolves++;
    else others++;
  }
  if (wolves === 0) return 'village';
  if (wolves >= others) return 'wolf';
  return null;
}

// votes: Map voter -> target. Return Map target -> [voters]
function tally(votes) {
  const m = new Map();
  for (const [voter, target] of votes) {
    if (!m.has(target)) m.set(target, []);
    m.get(target).push(voter);
  }
  return m;
}

// counts: Map target -> [voters]. Return { max, top: [targets dengan suara terbanyak] }
function topOf(counts) {
  let max = 0;
  let top = [];
  for (const [target, voters] of counts) {
    if (voters.length > max) {
      max = voters.length;
      top = [target];
    } else if (voters.length === max) top.push(target);
  }
  return { max, top };
}

module.exports = { ROLES, shuffle, roleSet, checkWin, tally, topOf };
