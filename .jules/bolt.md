## 2025-05-23 - Removed Dead O(N*M) Loop in Render Cycle
**Learning:** React render loops are critical paths. Calling a function that performs nested iterations (like finding a topic for a segment) inside `array.map()` for every item creates a multiplicative performance cost (O(N*M)). If the result is unused, it's pure waste.
**Action:** Always verify if the return value of a calculation inside a render loop is actually used. If not, delete it.
