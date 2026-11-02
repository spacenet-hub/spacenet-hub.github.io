---
layout: default
title: Home
---

<div class="content-container" markdown="1">

<div class="content-block" markdown="1">

# The Short Story

Space-based infrastructure such as LEO satellite networks (LSNs) have emerged as a major focus of networking research.

Pushing the frontier beyond current commercial deployments requires navigating a much larger problem space, including a wide range of space mission planning constraints that are presently not familiar to the networking community.

This website aims to provide a community-driven repository of these _outside intuitions_ that networking research must keep in mind when considering space-based infrastructure.

# Call for Contributions

This website is open-source and we encourage you to add your perspective and expertise by submitting [pull requests](https://github.com/SpaceNet-CoP/spacenet-cop.github.io/pulls) and [issues](https://github.com/SpaceNet-CoP/spacenet-cop.github.io/issues) or by joining discussion on existing threads.
Things to consider contributing:

* New "principles" that the community should consider.

* Refinements to existing principles to correct false arguments, add a nuanced perspective, or extend the scope of existing arguments.

* Citations to your papers, other relevant papers you think are missing, and other relevant and useful resources across the web.

</div>

<div class="content-block" markdown="1">

# The Long Story

Research involving space-based infrastructure requires navigating a wide range of space mission analysis and design considerations: for example, space physics, space craft engineering, launch constraints, etc.

It is typically not feasible for researchers to validate proposals for space-based systems against real-world infrastructure, especially as the research community continues to push beyond the particular designs of today's commercial deployments.

Due to this, researchers rely heavily on simulation frameworks and implicit modeling assumptions.
This creates a inherent methodological risk that proposed systems may satisfy networking objectives but **violate constraints faced by real-world space missions**, leading to _illusory_ results that are physically infeasible or operationally irrelevant.

**The goal of this website is to provide a centralized hub connecting networking researchers with the realities of space-based infrastructure.**
Concretely, we assemble the following principles that researchers should strive to abide by---regardless of what assumptions or simulations are utilized---in order to maintain alignment with the reality of space operations.

By assembling these principles as an open-source website, we aim to encourage on-going debate and refinement as well as continuous updates as space technologies progresses.

</div>

<div class="content-block" markdown="1">


# The Principles

**Avoid Collisions** [[PAGE](principles/collisions.html)] [[GAME](games/collision_avoidance/)]
<br/>
We should be sure satellites in the same constellation will not collide with each other.

**Near-Earth Hazards** [[PAGE](principles/hazards.html)]
<br/>
LSN designs should account for the structure of near-Earth hazards like the Van Allen radiation belts.

**Satellite Power Dynamics** [[PAGE](principles/power.html)}
<br/>
LSN designs should account for power dynamics such as passages through Earth's shadow and expected battery lifetimes.

**ISL Constraints** [[PAGE](principles/isls.html)]
<br/>
Proposed use of inter-satellite links (ISLs) should leverage link setup time constraints.

**Incremental Deployment** [[PAGE](principles/deployment.html)]
<br/>
LSN operations should account for costs and constraints of incrementally launching new constellations.

**Orbital Dynamics** [[PAGE](principles/dynamics.html)] [[GAME](games/orbital_dynamics/)]
<br/>
We should be sure that satellites are where we want them to be when we want them to be there over the LSN's full lifetime.

**Thermal Dynamics** [[STUB](principles/thermal.html)]
<br/>
Thinking about temperature in the near vacuum of space requires going beyond Earth-based intuitions about "hot" and "cold".

</div>

<div class="content-block" markdown="1">

# The Bibliography

We are curating a bibliography of relevant material cited throughout this site [here](bibliography.html) (or as bibtex [here](https://github.com/SpaceNet-CoP/spacenet-cop.github.io/raw/refs/heads/main/bibliography/references.bib)).

</div>

</div> <!-- .content-container -->
