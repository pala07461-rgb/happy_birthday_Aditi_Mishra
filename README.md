# 🌸 Aditi's Birthday Universe & Interactive Studio ✨

A personalized, interactive web universe created for **Aditi Mishra's Birthday**, featuring smooth scroll-driven storytelling, interactive mini-games, memories gallery, and a real-time admin telemetry inspector.

---

## 🌟 Highlights & Features

1. **🎡 Front Page (Month Gate)**:
   - Interactive celestial month dial.
   - Playful teaser prompts on wrong month selections, unlocking into cherry blossom wonderland when `October` is chosen.

2. **💡 Cherry Blossom Lamp & Balloon Wishes**:
   - Tap the vintage lamp to bloom the night sky with petals and festive lights.
   - Interactive balloon pops revealing heartwarming birthday messages.

3. **🎂 Cake & Candle Blowing Scene**:
   - Scroll-driven candle extinguishing sequence with celebratory fireworks.

4. **🖼️ Memory Polaroid Gallery**:
   - Rope-hung swinging polaroid photo cards (`Photo 1` through `Photo 5`) capturing cherished memories.

5. **🎮 3-Round Birthday Challenge Mini-Games**:
   - **Rematch Challenge Card**: *"ye dekh iss game tu haar gai thi 😆"* dare teaser.
   - **Corner Scroll-Lock (`#gameLockBtn` 🔒)**: Locks viewport scroll for seamless touch controls on mobile.
   - **Round 1 (Catch the Balloon)**: Aditi's pink cartoon arm vs Shubham's blue arm. Features the hilarious **Living Runaway Button** (`Okey! 👍` -> Jumps up in 1s -> Transforms with cartoon eyes & teasing mouth -> Sprints left in 2s with running legs and dust cloud -> Peeks back waving *"Bye bye! 👋😜"* -> Highlights *"Hmm"* button).
   - **Round 2 (Cut the Cake Slice)**: Aditi vs Shubham knife slicing battle.
   - **Round 3 (Balloon Pop)**: Realistic glossy balloons with knots and swaying threads. Features **5 Pink (🌸) and 3 Blue (💎)** persistent capacity with **2-second automatic replenishment**.
   - **Grand Scoreboard**: Displays total round scores and triggers smooth navigation to the final message.

6. **💌 Apology Note & Chat Screenshot**:
   - Apology note with the memorable chat screenshot (`tune abhi tak nhi kiya!! 🥺💗`).

7. **🎵 Floating Pink Music Speaker**:
   - Plays background song on entrance and reveals a floating pink speaker toggle once the song finishes.

8. **🔍 Hidden Admin Dashboard & Real-Time Telemetry Inspector**:
   - **Secret Trigger**: Tap the lamp **20 times** in 4 seconds (or passkey: `3788`).
   - **Recent Sessions Table**: Click any visitor row or **Inspect 🔍** to open the deep-dive telemetry inspector modal:
     - Button clicks & frequencies (*"Konsa button dabaya or kitni baar"*)
     - Section & page dwell times (*"Jiss jagah kitni der ruka"*)
     - Wrong month attempts & exact wrong months selected
     - Song listening duration & play/pause toggles
     - Scroll story duration & rewinds count (*"Dubara wahi se chalaya"*)
     - Lamp balloon pop delays (from lamp turn on and between pops)
     - Cake dwell before blowing candles
     - Memory photos dwell time & individual taps
     - Game rounds scores & corner lock button clicks
     - Step-by-step chronological activity timeline with timestamps

---

## 🚀 Local Development

Run with Node.js:

```bash
# 1. Start the server
npm start
# or
node server.js
```

Open your browser at:
- **Local PC**: `http://localhost:3000`
- **Mobile (Same Wi-Fi)**: `http://<your-local-ip>:3000`

---

## ⚡ 1-Click Deployment to Vercel

This repository is pre-configured for **Vercel** with zero-configuration static asset hosting and serverless API functions:

1. Push this repository to your GitHub account (already linked to `https://github.com/pala07461-rgb/happy_birthday_Aditi_Mishra.git`).
2. Go to [Vercel Dashboard](https://vercel.com/dashboard) and click **"Add New..." -> "Project"**.
3. Import `happy_birthday_Aditi_Mishra`.
4. Keep **Framework Preset** as **"Other"** (Root Directory: `./`).
5. Click **"Deploy"**!

Vercel automatically:
- Serves the frontend (`index.html`, `audio/`, `images/`) via high-speed global CDN edge.
- Routes all `/api/*` telemetry and admin endpoints to the serverless function in `api/index.js`.
