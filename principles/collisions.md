---
layout: default
title: Avoiding Collisions
---

<div class="content-container" markdown="1">
<div class="content-block" markdown="1">

# Avoiding Collisions

</div>
</div>

<div class="content-container" markdown="1">
<div class="content-block" markdown="1">

### Definition

Because propagation of satellite positions are approximate, avoiding collisions requires ensuring that the approximate locations of any pair of satellites (in the constellation) always exceeds a minimum "collision avoidance" threshold.

</div>
<div class="content-block" markdown="1">

### What happens?

Violation of this principle lead to constellations where the probability of collision between two satellites is unacceptably high. If actually launched, eventual collisions between satellites in these constellations could lead to constellation-wide de-orbit and spread of a debris field beyond the constellations initial altitude(s). Extreme worst-case possibilities are captured by the Kessler syndrome which posits collision rates will increase rapid to 100% after a certain threshold is crossed {% cite kessler1978collision chen2024unraveling %}.

</div>
<div class="content-block" markdown="1">

### Takeaways

LSN proposals must prove that their proposed orbits do not collide with each other at any point in time.
Note that this principle has been automatically realized in many prior efforts due to use of well-studied orbital geometries like Walker-delta, but does not hold by default in recent proposals that target novel networking-specific geometries.

</div>
<div class="content-block" markdown="1">

### The game

We made a simple game to illustrate the challenge of building customized constellation geometries. Play it [here](/games/collision_avoidance/)!

</div>

</div>

<div class="content-container" markdown="1">
<div class="content-block" markdown="1">

[Back](/)

</div>
</div>
