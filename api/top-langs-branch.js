// api/top-langs-branch.js
// 최소 의존 & 확실한 경로 & 전역 fetch 사용

// 💥 PRIMARY FIX: Added 'with { type: "json" }' to resolve ERR_IMPORT_ATTRIBUTE_MISSING
import languageMap from "language-map/languages.json" with { type: "json" }; 

// ✅ github-readme-stats 내부 카드 유틸의 정확한 경로/이름
import { renderTopLanguages } from "../src/cards/top-languages-card.js";
// 유틸 경로도 정확히 맞춰주세요
import { clampValue } from "../src/common/utils.js";

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
    if (exts.some(e => e.replace(/^\./, "") === ext)) return lang;
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
    if (!r.ok) throw new Error(`List repos failed for ${user}: ${r.status} ${await r.text()}`);
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

  // 1) branch -> commit sha
  const bRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`, { headers });
  if (!bRes.ok) {
    // 브랜치 없으면 스킵
    if (bRes.status === 404) return [];
    throw new Error(`Branch lookup failed ${owner}/${repo}#${branch}: ${bRes.status} ${await bRes.text()}`);
  }
  const bJson = await bRes.json();
  const sha = bJson?.commit?.sha;
  if (!sha) return [];

  // 2) recursive tree
  const tRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`, { headers });
  if (!tRes.ok) {
    if (tRes.status === 409) return []; // empty repo
    throw new Error(`Tree fetch failed ${owner}/${repo}@${sha}: ${tRes.status} ${await tRes.text()}`);
  }
  const tJson = await tRes.json();
  return tJson?.tree || [];
}

function aggregateByLanguageFromTree(tree) {
  const totals = {};
  for (const item of tree) {
    if (item.type !== "blob") continue;
    // 일부 케이스에 size가 없을 수 있음 → 그런 파일은 스킵
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
      debug,
    } = req.query;

    const token = process.env.PAT_1;
    if (!token) {
      res.status(500).send("PAT_1 env not set");
      return;
    }

    if (!user) {
      res.status(400).send("Provide ?user=username");
      return;
    }

    const exclude = new Set(toArray(exclude_repos).map(x => x.toLowerCase()));
    const hideList = new Set(toArray(hide).map(x => x.toLowerCase()));
    const allowForks = toBool(include_forks, false);
    const allowArchived = toBool(include_archived, false);
    const maxRepos = clampValue(parseInt(max_repos, 10) || 60, 1, 300);

    // 1) 대상 레포 목록
    const listed = await fetchAllUserRepos(token, user, allowForks, allowArchived);
    const repoFullNames = listed
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

    // 2) 언어 합산
    const totals = await aggregateRepos(token, repoFullNames, branch);
    for (const k of Object.keys(totals)) {
      if (hideList.has(k.toLowerCase())) delete totals[k];
    }

    // 3) 상위 N
    const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    const topN = clampValue(parseInt(langs_count, 10) || 6, 1, 20);
    const top = sorted.slice(0, topN);
    
    // ⭐️⭐️⭐️ 문제 해결을 위한 핵심 수정 부분: 언어 색상 정보를 추가합니다. ⭐️⭐️⭐️
    const items = top.map(([name, size]) => {
      // languageMap에서 해당 언어의 메타데이터를 가져옵니다.
      const langMeta = languageMap[name];
      // 색상 정보를 추출하거나, 정보가 없을 경우 기본 회색(#858585)을 사용합니다.
      const color = langMeta?.color || "#858585"; 
      
      return { 
        name, 
        size, 
        color, // color 속성을 객체에 추가
      };
    });
    // ⭐️⭐️⭐️ 수정 끝 ⭐️⭐️⭐️

    // 4) 카드 렌더 (기존 컴포넌트 재사용)
    const svg = renderTopLanguages(items, {
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
    });

    // 디버그 텍스트로 확인하고 싶을 때(문제 발생 시)
    if (toBool(debug, false)) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.status(200).send(JSON.stringify({ branch, repoCount: repoFullNames.length, repos: repoFullNames, totals, items }, null, 2));
      return;
    }

    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "max-age=1800, s-maxage=1800");
    res.status(200).send(svg);
  } catch (e) {
    // Vercel 로그에서 메시지 확인 쉽게
    console.error("[top-langs-branch] error", e);
    res.status(500).send(`Error: ${e?.message || e}`);
  }
}