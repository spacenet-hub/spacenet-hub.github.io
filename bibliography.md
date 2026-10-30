---
layout: default
title: Bibliography

# jekyll-scholar settings for the bibliography on this page only. They are
# merged over the `scholar:` block in _config.yml, so citations elsewhere on
# the site are unaffected and _config.yml needs no changes.
scholar:
  sort_by: year,title
  order: descending,ascending
  # Fields left out of the "BibTeX" box / "Copy BibTeX" button.
  bibtex_skip_fields: [abstract, annote, category, month_numeric]
  # How each entry is drawn. jekyll-scholar provides: reference (the formatted
  # APA citation, wrapped in <span id="KEY">), key, type, and entry (all fields).
  bibliography_template: |
    {%- assign abstract = entry.abstract | strip -%}
    {%- assign note = entry.annote | strip -%}
    {%- assign weblink = entry.url | default: entry.howpublished | strip -%}
    {%- if entry.author_array -%}
      {%- assign sortname = entry.author_array.first.last -%}
    {%- else -%}
      {%- assign sortname = entry.title -%}
    {%- endif -%}
    {%- case type -%}
      {%- when "article" -%}{%- assign kind = "Journal article" -%}
      {%- when "inproceedings" -%}{%- assign kind = "Conference paper" -%}
      {%- when "book" -%}{%- assign kind = "Book" -%}
      {%- when "techreport" -%}{%- assign kind = "Report" -%}
      {%- when "phdthesis" or "mastersthesis" -%}{%- assign kind = "Thesis" -%}
      {%- when "misc" -%}{%- assign kind = "Online" -%}
      {%- else -%}{%- assign kind = type | capitalize -%}
    {%- endcase -%}
    <details class="bib-entry" data-key="{{ key }}" data-year="{{ entry.year }}" data-sort-name="{{ sortname | escape }}" data-authors="{{ entry.author | escape }}" data-title="{{ entry.title | escape }}">
    <summary>
    <span class="bib-ref">{{ reference }}</span>
    <span class="bib-tags"><span class="bib-tag">{{ kind }}</span>{% if abstract != "" %}<span class="bib-tag bib-tag-abs">Abstract</span>{% elsif note != "" %}<span class="bib-tag bib-tag-abs">Summary</span>{% endif %}</span>
    </summary>
    <div class="bib-body">
    {%- if abstract != "" %}
    <p class="bib-label">Abstract</p>
    <p class="bib-abstract">{{ abstract | escape }}</p>
    {%- endif %}
    {%- if note != "" %}
    <p class="bib-label">{% if abstract != "" %}Note{% else %}Summary{% endif %}</p>
    <p class="bib-note">{{ note | escape }}</p>
    {%- endif %}
    {%- if abstract == "" and note == "" %}
    <p class="bib-empty">No abstract yet.</p>
    {%- endif %}
    <p class="bib-actions">
    {%- if entry.doi and entry.doi != "" %}<a class="bib-btn" href="https://doi.org/{{ entry.doi }}" target="_blank" rel="noopener">DOI</a>{% endif %}
    {%- if weblink contains "://" %}<a class="bib-btn" href="{{ weblink }}" target="_blank" rel="noopener">{% if type == "misc" %}Website{% else %}Link{% endif %}</a>{% endif %}
    <button type="button" class="bib-btn" data-bib-action="bibtex" aria-expanded="false">BibTeX</button>
    <button type="button" class="bib-btn" data-bib-action="copy-bibtex">Copy BibTeX</button>
    <button type="button" class="bib-btn" data-bib-action="copy-link">Copy link</button>
    </p>
    <pre class="bib-bibtex" hidden><code>{{ entry.bibtex | escape }}</code></pre>
    </div>
    </details>
---

<!-- Big thanks to Gemma Danks: https://open-research.gemmadanks.com/tutorials/how-to-use-jekyll-scholar-with-github-pages/ -->

<link rel="stylesheet" href="{{ '/assets/css/bibliography.css' | relative_url }}">

{%- assign bib_ids = site.data.bibliography | map: "id" -%}
{%- capture bib_other_query -%}@*[{% for id in bib_ids %}category!={{ id }}{% unless forloop.last %},{% endunless %}{% endfor %}]{%- endcapture %}

<div class="bib-app" data-bib>
<header class="bib-head">
<h1>References</h1>
<p>Papers, reports, and tools cited across this site, grouped by topic.
Click any entry to read its abstract or summary, and use the search box to look across authors, titles, and abstracts.
Entries marked <em>Summary</em> were written for this site rather than by the authors.
The full list is also available as <a href="https://github.com/SpaceNet-CoP/spacenet-cop.github.io/raw/refs/heads/main/bibliography/references.bib">BibTeX</a>.</p>
</header>

<aside class="bib-sidebar">
<div class="bib-controls">
<label class="bib-sr-only" for="bib-search">Search the bibliography</label>
<div class="bib-search-wrap">
<svg class="bib-search-icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="M13 13l4.5 4.5"/></svg>
<input id="bib-search" type="search" placeholder="Search authors, titles, abstracts" autocomplete="off" spellcheck="false">
</div>
<div class="bib-scope" role="group" aria-label="Search in">
<button type="button" data-scope="all" aria-pressed="true">All</button>
<button type="button" data-scope="author" aria-pressed="false">Author</button>
<button type="button" data-scope="title" aria-pressed="false">Title</button>
<button type="button" data-scope="abstract" aria-pressed="false">Abstract</button>
</div>
</div>
<div class="bib-meta">
<div class="bib-tools">
<label for="bib-sort">Sort</label>
<select id="bib-sort">
<option value="newest">Newest first</option>
<option value="oldest">Oldest first</option>
<option value="author">Author A–Z</option>
</select>
<button type="button" class="bib-link-btn" id="bib-toggle-all">Expand all</button>
</div>
<p class="bib-status" id="bib-status" aria-live="polite"></p>
</div>
<nav class="bib-nav" aria-label="Categories">
<ol>
{%- for cat in site.data.bibliography %}
<li><a href="#cat-{{ cat.id }}" data-cat="{{ cat.id }}"><span>{{ cat.title }}</span><span class="bib-count"></span></a></li>
{%- endfor %}
<li><a href="#cat-other" data-cat="other"><span>Other</span><span class="bib-count"></span></a></li>
</ol>
</nav>
</aside>

<div class="bib-main">
{%- for cat in site.data.bibliography %}
<section class="bib-section" id="cat-{{ cat.id }}" data-cat="{{ cat.id }}">
<header class="bib-section-head">
<h2>{{ cat.title }}</h2>
<p>{{ cat.blurb }}{% if cat.principle %} <a href="{{ cat.principle | relative_url }}">Related&nbsp;principle&nbsp;→</a>{% endif %}</p>
</header>
{% bibliography --query @*[category={{ cat.id }}] %}
</section>
{%- endfor %}
<section class="bib-section" id="cat-other" data-cat="other">
<header class="bib-section-head">
<h2>Other</h2>
<p>Entries with no <code>category</code> field, or one not listed in <code>_data/bibliography.yml</code>.</p>
</header>
{% bibliography --query {{ bib_other_query }} %}
</section>
<p class="bib-empty-results" id="bib-no-results" hidden>No references match your search.</p>
<p class="bib-back"><a href="{{ '/' | relative_url }}">Back</a></p>
</div>
</div>

<script src="{{ '/assets/js/bibliography.js' | relative_url }}" defer></script>
