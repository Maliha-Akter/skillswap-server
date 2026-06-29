# SkillSwap — Freelance Micro-Task Platform

SkillSwap is a responsive, full-stack freelance marketplace where clients can post small, bite-sized contracts (e.g., logo design, copy editing, or quick bug fixes) and freelancers can submit proposals to get hired. Built as a high-performance modern alternative to platforms like Fiverr or Freelancer.com, it streamlines secure workflows from posting to payment.

## 🔗 Project Links
- **Live Deployment Platform**: [SkillSwap Live](https://skillswap-client-three.vercel.app/)
- **Frontend Repository**: [GitHub Client](https://github.com/Maliha-Akter/skillswap-client)
- **Backend Repository**: [GitHub Server](https://github.com/Maliha-Akter/skillswap-server)

---

## 🚀 Key Features

### 👤 Role-Based Portals & Core Dashboards
- **Client Route (`/dashboard/client`)**: Form layout engine to post new projects, review incoming freelancer proposals, reject unwanted bids, or accept proposals via checkout.
- **Freelancer Route (`/dashboard/freelancer`)**: Portal to track submitted proposals, manage active project deliverables via interactive modals, edit profiles, and view breakdown metrics of lifetime earnings.
- **Admin Control System (`/dashboard/admin`)**: Hardcoded master system to monitor all platform accounts, toggle account block statuses dynamically, track live task safety constraints, and review absolute Stripe payment history tracking lists.

### 🛡️ Enterprise Security & Validation Architecture
- **BetterAuth Integration**: Credential email-and-password sign-up maps alongside Google OAuth integration setups smoothly.
- **Asymmetric JWT Verification**: Secure authentication gateway utilizing a remote JWKS dataset endpoint to block malicious network traffic vectors on private backend endpoints.
- **Persistent Middleware Protection**: Advanced route matching patterns under `/dashboard/*` to automatically isolate unauthenticated or unauthorized accounts.

### 🔍 Advanced UX Engineering
- **Server-Driven Query Offsets**: Real-time server-side pagination limiting defaults to **9 items per query execution limit** with complete URL state tracking symmetry (`?page=1`).
- **Compound State Matrix Filter**: Blended text debouncing title exploration that operates simultaneously with category criteria selection checkboxes and minimum/maximum budget restrictions.
- **Adaptive Visual Architecture**: Premium custom dark mode layout designed with deep zinc components, clean typography gradients, and responsive navigation layouts for any screen size.

---

## 📦 Core NPM Packages Installed

### 💻 Frontend (Client Application)
* **`next`** (v14/15) - Core Framework for React Server Components and optimized page structures.
* **`react`** / **`react-dom`** - Application engine.
* **`@heroui/react`** - Premium UI library providing accessible, pre-styled glassmorphic elements, layouts, and input components.
* **`framer-motion`** - Core engine behind HeroUI's smooth, fluid visual transitions and page-load animations.
* **`lucide-react`** / **`react-icons`** - Custom visual styling sets (FontAwesome icons grid ecosystem).
* **`tailmerge`** / **`clsx`** / **`tailwindcss`** - Modular design spacing, typography configurations, and responsive sidebars.

### ⚙️ Backend (Server Application)
* **`express`** - Minimalist web framework engine routing incoming server connections.
* **`mongodb`** / **`mongoose`** - Secure data access layers parsing client collection attributes.
* **`jose`** - Lightweight JWT token verification layer resolving public key distribution sets via `createRemoteJWKSet`.
* **`cors`** - Cross-Origin Resource Sharing handling mechanisms allowing secure API access permissions.
* **`dotenv`** - Environmental storage configuration container parsing database connections.