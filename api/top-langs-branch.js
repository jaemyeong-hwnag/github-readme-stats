// api/top-langs-branch.js
import fetch from "node-fetch";
import languageMap from "language-map";
import { renderTopLanguages } from "../src/cards/top-languages-card";
import { clampValue } from "../src/utils/utils";

const GITHUB_API = "https://api.github.com";

function toArray(q) {
  if (!q) return [];
  return q.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
}

function toBool(q, def = false) {
  if (q == null) return def;
  return ["1", "true", "yes", "y", "on"].includes(String(q).toLowerCase());
}

function extToLanguage(filename) {
  const idx = filename.lastIndexOf(".");
  if (idx <= 0) return null;
  const ext = filename.slice(idx + 1).toLowerCase();
  for (const [lang, meta] of Object.entries(languageMap)) {
    const exts = meta.extensions || [];
    if (exts.some(e => e.replace(/^\./, "") === ext)) {
      return lang;
    }
  }
  return null;
}

async function fetchAllUserRepos(token, user, includeForks, includeArchived, perPage = 100, maxPages = 5) {
  const headers = {
    Authorization: `token ${token}`,
    "User-Agent": "github-readme-stats-branch",
    Accept: "application/vnd.github+json",
  };
  let page = 1;
  const acc = [];
  while (page <= maxPages) {
    const url = `${GITHUB_API}/users/${encodeURIComponent(user)}/repos?per_page=${perPage}&page=${page}&type=owner&sort=updated`;
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`Failed to list repos for ${user}: ${r.status}`);
    const js = await r.json();
    if (!Array.isArray(js) || js.length === 0) break;
    acc.push(
      ...js.filter(repo => {
        if (!includeForks && repo.fork) return false;
        if (!includeArchived && repo.archived) return false;
        return true;
      })
    );
    page++;
  }
  return acc.map(r => ({ full_name: r.full_name }));
}

async function fetchRepoTreeByBranch(token, owner, repo, branch) {
  const headers = {
    Authorization: `token ${token}`,
    "User-Agent": "github-readme-stats-branch",
    Accept: "application/vnd.github+json",
  };

  const bRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`, { headers });
  if (!bRes.ok) {
    if (bRes.status === 404) return [];
    throw new Error(`Branch lookup failed ${owner}/${repo}#${branch}: ${bRes.status}`);
  }
  const bJson = await bRes.json();
  const sha = bJson?.commit?.sha;
  if (!sha) return [];

  const tRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`, { headers });
  if (!tRes.ok) {
    if (tRes.status === 409) return [];
    throw new Error(`Tree fetch failed ${owner}/${repo}@${sha}: ${tRes.status}`);
  }
  const tJson = await tRes.json();
  return tJson?.tree || [];
}

function aggregateByLanguageFromTree(tree) {
  const totals = {};
  for (const item of tree) {
    if (item.type !== "blob") continue;
    if (typeof item.size !== "number") continue;
    const lang = extToLanguage(item.path);
    if (!lang) continue;
    totals[lang] = (totals[lang] || 0) + item.size;
  }
  return totals;
}

async function aggregateRepos(token, repoFullNames, branch) {
  const grand = {};
  for (const full of repoFullNames) {
    const [owner, repo] = full.split("/");
    if (!owner || !repo) continue;
    const tree = await fetchRepoTreeByBranch(token, owner, repo, branch);
    if (!tree.length) continue;
    const byLang = aggregateByLanguageFromTree(tree);
    for (const [k, v] of Object.entries(byLang)) {
      grand[k] = (grand[k] || 0) + v;
    }
  }
  return grand;
}

export default async function handler(req, res) {
  try {
    const {
      user,
      branch = "develop",
      exclude_repos = "",
      include_forks,
      include_archived,
      hide = "",
      hide_title,
      card_width,
      layout = "compact",
      langs_count = "6",
      theme,
      bg_color,
      title_color,
      text_color,
      icon_color,
      border_color,
      hide_border,
      locale,
      custom_title,
      max_repos = "60",
    } = req.query;

    const token = process.env.PAT_1;
    if (!token) {
      res.status(500).send("PAT_1 env not set");
      return;
    }

    const exclude = new Set(toArray(exclude_repos).map(x => x.toLowerCase()));
    const hideList = new Set(toArray(hide).map(x => x.toLowerCase()));
    const allowForks = toBool(include_forks, false);
    const allowArchived = toBool(include_archived, false);
    const maxRepos = clampValue(parseInt(max_repos, 10) || 60, 1, 300);

    let repoFullNames = [];
    if (!user) {
      res.status(400).send("Provide ?user=username");
      return;
    }

    const listed = await fetchAllUserRepos(token, user, allowForks, allowArchived);
    repoFullNames = listed
      .map(r => r.full_name)
      .filter(full => {
        const name = full.split("/")[1]?.toLowerCase() || "";
        return !exclude.has(name);
      })
      .slice(0, maxRepos);

    if (repoFullNames.length === 0) {
      res.status(404).send("No repositories to analyze after filters.");
      return;
    }

    const totals = await aggregateRepos(token, repoFullNames, branch);
    for (const k of Object.keys(totals)) {
      if (hideList.has(k.toLowerCase())) delete totals[k];
    }

    const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    const topN = clampValue(parseInt(langs_count, 10) || 6, 1, 20);
    const top = sorted.slice(0, topN);

    const totalBytes = top.reduce((acc, [, v]) => acc + v, 0);
    const items = top.map(([name, size]) => ({ name, size, percent: totalBytes ? (size / totalBytes) * 100 : 0 }));

    const svg = renderTopLanguages(
      items.map(i => ({ name: i.name, size: i.size })),
      {
        hide_title: toBool(hide_title, false),
        card_width: card_width ? Number(card_width) : undefined,
        layout,
        langs_count: topN,
        theme,
        bg_color,
        title_color,
        text_color,
        icon_color,
        border_color,
        hide_border: toBool(hide_border, false),
        locale,
        custom_title: custom_title || `Top Languages (${branch})`,
      }
    );

    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "max-age=1800, s-maxage=1800");
    res.status(200).send(svg);
  } catch (e) {
    res.status(500).send(`Error: ${e?.message || e}`);
  }
}