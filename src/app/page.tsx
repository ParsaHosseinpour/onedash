import Link from "next/link";
import WaitlistForm from "./components/WaitlistForm";

/**
 * OneDash — Landing Page (v0.1)
 *
 * This is the marketing page. It explains WHAT OneDash is, WHY it's different,
 * and invites visitors to join the waitlist. No login, no dashboard yet —
 * those come in later versions (see ROADMAP.md).
 */
export default function Home() {
  return (
    <main className="flex-1">
      {/* ====================================================
          NAV BAR
      ==================================================== */}
      <nav className="border-b border-[color:var(--border)] backdrop-blur-sm">
        <div className="mx-auto max-w-6xl px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Logo />
            <span className="font-semibold tracking-tight">OneDash</span>
          </div>
          <div className="flex items-center gap-6 text-sm">
            <Link
              href="#features"
              className="text-[color:var(--foreground-muted)] hover:text-[color:var(--foreground)] transition-colors"
            >
              Features
            </Link>
            <Link
              href="#pricing"
              className="text-[color:var(--foreground-muted)] hover:text-[color:var(--foreground)] transition-colors"
            >
              Pricing
            </Link>
            <Link
              href="#waitlist"
              className="rounded-lg bg-[color:var(--accent)] px-4 py-2 font-medium text-[#0a0e1a] hover:bg-[color:var(--accent-dim)] transition-colors"
            >
              Join waitlist
            </Link>
          </div>
        </div>
      </nav>

      {/* ====================================================
          HERO
      ==================================================== */}
      <section className="grid-bg border-b border-[color:var(--border)]">
        <div className="mx-auto max-w-4xl px-6 py-24 text-center">
          {/* status pill */}
          <div className="inline-flex items-center gap-2 rounded-full border border-[color:var(--border)] bg-[color:var(--background-elevated)] px-4 py-1.5 text-sm">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[color:var(--accent)] opacity-75"></span>
              <span className="relative inline-flex h-2 w-2 rounded-full bg-[color:var(--accent)]"></span>
            </span>
            <span className="text-[color:var(--foreground-muted)]">
              All systems operational
            </span>
          </div>

          <h1 className="mt-6 text-5xl md:text-6xl font-bold tracking-tight">
            Know when your app breaks.
            <br />
            <span className="text-[color:var(--accent)]">
              In 60 seconds or less.
            </span>
          </h1>

          <p className="mt-6 text-lg md:text-xl text-[color:var(--foreground-muted)] max-w-2xl mx-auto">
            OneDash is uptime monitoring built for indie devs and small teams.
            Get pinged the moment your site, API, or cron job goes down — with
            zero false alarms.
          </p>

          <div className="mt-10 flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              href="#waitlist"
              className="rounded-lg bg-[color:var(--accent)] px-6 py-3 font-semibold text-[#0a0e1a] hover:bg-[color:var(--accent-dim)] transition-colors"
            >
              Get early access →
            </Link>
            <Link
              href="#features"
              className="rounded-lg border border-[color:var(--border)] px-6 py-3 font-medium hover:bg-[color:var(--background-elevated)] transition-colors"
            >
              See how it works
            </Link>
          </div>

          <p className="mt-4 text-sm text-[color:var(--foreground-muted)]">
            Free forever for commercial use · No credit card required
          </p>
        </div>
      </section>

      {/* ====================================================
          THE WEDGE — why we're different
      ==================================================== */}
      <section className="border-b border-[color:var(--border)]">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight">
              Why developers switch to OneDash
            </h2>
            <p className="mt-3 text-[color:var(--foreground-muted)]">
              We built OneDash because the big tools stopped caring about indie
              devs. Here&apos;s what we do differently.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <FeatureCard
              icon="🆓"
              title="Free for commercial use"
              description="Monitor your actual SaaS, client sites, and APIs — for free. Unlike UptimeRobot, we don't paywall indie devs out of commercial projects."
            />
            <FeatureCard
              icon="🎯"
              title="Zero false alarms"
              description="We confirm outages from 2+ locations before alerting you. No more 3am wake-ups because of a network hiccup."
            />
            <FeatureCard
              icon="💬"
              title="All alert channels free"
              description="Email, Discord, Telegram, and webhooks — on every plan. We don't paywall basic features."
            />
          </div>
        </div>
      </section>

      {/* ====================================================
          FEATURES
      ==================================================== */}
      <section id="features" className="border-b border-[color:var(--border)]">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight">
              Everything you need to sleep at night
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Bullet>Monitor websites, APIs, ping, ports, and cron jobs</Bullet>
            <Bullet>1-minute check intervals on the Pro plan</Bullet>
            <Bullet>Public status page with your own branding</Bullet>
            <Bullet>Response time charts and uptime history</Bullet>
            <Bullet>Incident timeline — know exactly what happened</Bullet>
            <Bullet>Open-source core — host it yourself if you want</Bullet>
          </div>
        </div>
      </section>

      {/* ====================================================
          PRICING
      ==================================================== */}
      <section id="pricing" className="border-b border-[color:var(--border)]">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight">
              Simple, honest pricing
            </h2>
            <p className="mt-3 text-[color:var(--foreground-muted)]">
              Start free. Upgrade only when you outgrow it.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <PriceCard
              name="Free"
              price="$0"
              period="forever"
              features={[
                "10 monitors",
                "5-minute checks",
                "Email alerts",
                "1 status page",
              ]}
              cta="Join waitlist"
            />
            <PriceCard
              name="Pro"
              price="$9"
              period="per month"
              highlighted
              features={[
                "50 monitors",
                "1-minute checks",
                "Discord + Telegram + SMS",
                "Custom status page domain",
                "No OneDash branding",
              ]}
              cta="Join waitlist"
            />
            <PriceCard
              name="Team"
              price="$29"
              period="per month"
              features={[
                "Unlimited monitors",
                "5 team seats",
                "Audit logs",
                "Multi-region checks",
                "Priority support",
              ]}
              cta="Join waitlist"
            />
          </div>
        </div>
      </section>

      {/* ====================================================
          WAITLIST
      ==================================================== */}
      <section id="waitlist" className="border-b border-[color:var(--border)]">
        <div className="mx-auto max-w-2xl px-6 py-24 text-center">
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight">
            Get early access
          </h2>
          <p className="mt-3 text-[color:var(--foreground-muted)]">
            OneDash is in private beta. Drop your email and we&apos;ll let you
            in early — plus a free Pro upgrade for the first 100 signups.
          </p>

          <WaitlistForm />
        </div>
      </section>

      {/* ====================================================
          FOOTER
      ==================================================== */}
      <footer className="mx-auto max-w-6xl px-6 py-10 text-sm text-[color:var(--foreground-muted)]">
        <div className="flex flex-col sm:flex-row justify-between items-center gap-4">
          <div className="flex items-center gap-2">
            <Logo />
            <span>OneDash</span>
            <span className="text-xs">· v0.1</span>
          </div>
          <div className="flex gap-6">
            <Link href="#" className="hover:text-foreground transition-colors">
              GitHub
            </Link>
            <Link href="#" className="hover:text-foreground transition-colors">
              Twitter
            </Link>
            <Link href="#" className="hover:text-foreground transition-colors">
              Privacy
            </Link>
          </div>
        </div>
        <div className="mt-6 text-center text-xs">
          Built with ♥ in Canada 🇨🇦 by Parsa
        </div>
      </footer>
    </main>
  );
}

/* =========================================================
   Small reusable components (kept in the same file for v0.1;
   we'll split them out as the app grows).
   ========================================================= */

function Logo() {
  return (
    <div className="flex h-7 w-7 items-center justify-center rounded-md bg-[color:var(--accent)] text-[#0a0e1a] font-bold text-sm">
      1
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: string;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-xl border border-[color:var(--border)] bg-[color:var(--background-elevated)] p-6 hover:border-[color:var(--accent)] transition-colors">
      <div className="text-3xl mb-4">{icon}</div>
      <h3 className="font-semibold text-lg">{title}</h3>
      <p className="mt-2 text-[color:var(--foreground-muted)] text-sm leading-relaxed">
        {description}
      </p>
    </div>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-[color:var(--border)] bg-[color:var(--background-elevated)] px-4 py-3">
      <span className="text-[color:var(--accent)] mt-0.5">✓</span>
      <span className="text-sm">{children}</span>
    </div>
  );
}

function PriceCard({
  name,
  price,
  period,
  features,
  cta,
  highlighted = false,
}: {
  name: string;
  price: string;
  period: string;
  features: string[];
  cta: string;
  highlighted?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-6 ${
        highlighted
          ? "border-[color:var(--accent)] bg-[color:var(--background-elevated)]"
          : "border-[color:var(--border)]"
      }`}
    >
      {highlighted && (
        <div className="mb-3 inline-block rounded-full bg-[color:var(--accent)] px-3 py-0.5 text-xs font-semibold text-[#0a0e1a]">
          Most popular
        </div>
      )}
      <h3 className="font-semibold text-lg">{name}</h3>
      <div className="mt-2">
        <span className="text-4xl font-bold">{price}</span>
        <span className="text-[color:var(--foreground-muted)] text-sm ml-1">
          {period}
        </span>
      </div>
      <ul className="mt-6 space-y-2 text-sm">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2">
            <span className="text-[color:var(--accent)] mt-0.5">✓</span>
            <span>{f}</span>
          </li>
        ))}
      </ul>
      <Link
        href="#waitlist"
        className={`mt-6 block rounded-lg px-4 py-2.5 text-center font-medium transition-colors ${
          highlighted
            ? "bg-[color:var(--accent)] text-[#0a0e1a] hover:bg-[color:var(--accent-dim)]"
            : "border border-[color:var(--border)] hover:bg-[color:var(--background-elevated)]"
        }`}
      >
        {cta}
      </Link>
    </div>
  );
}
