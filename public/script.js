(function () {
  "use strict";

  // ── Stars ───────────────────────────────────────────────────
  !function(){const c=document.getElementById("starsCanvas");if(!c)return;const x=c.getContext("2d");let w,h,s;function r(){w=c.width=innerWidth;h=c.height=innerHeight}function m(n){s=[];for(let i=0;i<n;i++)s.push({x:Math.random()*w,y:Math.random()*h,r:Math.random()*1.4+.3,a:Math.random()*.7+.2,v:Math.random()*.3+.05,p:Math.random()*Math.PI*2})}function d(t){x.clearRect(0,0,w,h);s.forEach(p=>{x.beginPath();x.arc(p.x,p.y,p.r,0,Math.PI*2);x.fillStyle=`rgba(255,255,255,${p.a*(Math.sin(t*.001*p.v+p.p)*.3+.7)})`;x.fill()});requestAnimationFrame(d)}r();m(180);addEventListener("resize",()=>{r();m(180)});requestAnimationFrame(d)}();

  // ── State ───────────────────────────────────────────────────
  let state = {
    role: null,
    accessToken: null,
    offerCountry: "JP",
    billingCountry: "ID",
    mode: "hosted",
    lastCheckoutUrl: null,
  };

  const $ = id => document.getElementById(id);

  let countriesData = [];
  let statesData = {};

  // ── Load countries/states data ──
  async function loadCountriesData() {
    try {
      const res = await fetch("/api/countries");
      const data = await res.json();
      countriesData = data.countries || [];
      statesData = data.states || {};
      populateCountryDropdown();
    } catch (e) { console.error("Failed to load countries", e); }
  }

  function populateCountryDropdown() {
    const sel = $("addrCountry");
    if (!sel) return;
    sel.innerHTML = '<option value="">Select Country *</option>';
    countriesData.forEach(c => {
      const opt = document.createElement("option");
      opt.value = c.code;
      opt.textContent = c.name;
      sel.appendChild(opt);
    });
  }

  function updateStateDropdown(countryCode) {
    const sel = $("addrState");
    if (!sel) return;
    sel.innerHTML = '<option value="">State (if applicable)</option>';
    const states = statesData[countryCode];
    if (states && states.length) {
      states.forEach(s => {
        const opt = document.createElement("option");
        opt.value = s.code;
        opt.textContent = s.name;
        sel.appendChild(opt);
      });
    }
  }

  // Listen for country change
  document.addEventListener('DOMContentLoaded', () => {
    const countryEl = $("addrCountry");
    if (countryEl) countryEl.addEventListener('change', () => updateStateDropdown(countryEl.value));
  });

  // ══════════════════════════════════════════════════════════════
  // AUTH
  // ══════════════════════════════════════════════════════════════
  async function checkAuth() {
    try {
      const res = await fetch("/api/auth/me");
      const data = await res.json();
      if (data.authenticated) {
        // Always start as user — admin requires re-entering password each time
        state.role = "user";
        showApp();
      } else {
        showLogin();
      }
    } catch (e) { showLogin(); }
  }

  function showLogin() {
    $("loginScreen").classList.remove("hidden");
    $("mainApp").classList.add("hidden");
    $("loginPassword").focus();
  }

  function showApp() {
    $("loginScreen").classList.add("hidden");
    $("mainApp").classList.remove("hidden");

    // If already admin, load config
    if (state.role === "admin") loadAdminConfig();
  }

  // Login
  $("btnLogin").onclick = doLogin;
  $("loginPassword").onkeydown = (e) => { if (e.key === "Enter") doLogin(); };

  async function doLogin() {
    const pw = $("loginPassword").value.trim();
    if (!pw) return;

    $("btnLogin").disabled = true;
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      const data = await res.json();
      $("btnLogin").disabled = false;

      if (!res.ok || !data.success) {
        $("loginError").textContent = data.error || "Invalid password";
        $("loginError").classList.remove("hidden");
        return;
      }

      state.role = data.role;
      $("loginError").classList.add("hidden");
      $("loginPassword").value = "";
      showApp();
    } catch (e) {
      $("btnLogin").disabled = false;
      $("loginError").textContent = "Connection error";
      $("loginError").classList.remove("hidden");
    }
  }

  // Logout
  window.doLogout = async function () {
    await fetch("/api/auth/logout", { method: "POST" });
    state.role = null;
    showLogin();
  };

  // ══════════════════════════════════════════════════════════════
  // ADMIN
  // ══════════════════════════════════════════════════════════════
  window.toggleAdmin = function () {
    if (state.role === "admin") {
      // Already admin, toggle panel
      $("adminPanel").classList.toggle("hidden");
    } else {
      // Show admin password modal
      $("adminModal").classList.remove("hidden");
      $("adminModalPassword").value = "";
      $("adminModalError").classList.add("hidden");
      $("adminModalPassword").focus();
    }
  };

  window.closeAdminModal = function () {
    $("adminModal").classList.add("hidden");
  };

  window.doAdminLogin = async function () {
    const pw = $("adminModalPassword").value.trim();
    if (!pw) return;
    try {
      const res = await fetch("/api/auth/admin", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      const data = await res.json();
      if (!res.ok) {
        $("adminModalError").textContent = data.error || "Invalid password";
        $("adminModalError").classList.remove("hidden");
        return;
      }
      state.role = "admin";
      $("adminModal").classList.add("hidden");
      await loadAdminConfig();
      $("adminPanel").classList.remove("hidden");
    } catch (e) {
      $("adminModalError").textContent = "Connection error";
      $("adminModalError").classList.remove("hidden");
    }
  };

  $("adminModalPassword").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doAdminLogin();
  });

  async function loadAdminConfig() {
    try {
      const res = await fetch("/api/admin/config");
      const data = await res.json();
      $("adminProxy").value = data.globalProxy || "";
      $("adminCheckoutProxy").value = data.checkoutProxy || "";
      // Load countries data then addresses
      await loadCountriesData();
      await loadAddresses();
    } catch (e) {}
  }

  window.saveProxy = async function () {
    const proxy = $("adminProxy").value.trim();
    try {
      await fetch("/api/admin/proxy", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxy }),
      });
      $("proxyStatus").textContent = proxy ? "✅ Proxy saved" : "✅ Proxy cleared";
      $("proxyStatus").style.color = "var(--green)";
      setTimeout(() => { $("proxyStatus").textContent = ""; }, 3000);
    } catch (e) {
      $("proxyStatus").textContent = "❌ Error saving";
      $("proxyStatus").style.color = "var(--error)";
    }
  };

  window.saveCheckoutProxy = async function () {
    const proxy = $("adminCheckoutProxy").value.trim();
    try {
      await fetch("/api/admin/checkout-proxy", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxy }),
      });
      $("checkoutProxyStatus").textContent = proxy ? "✅ Checkout proxy saved" : "✅ Checkout proxy cleared";
      $("checkoutProxyStatus").style.color = "var(--green)";
      setTimeout(() => { $("checkoutProxyStatus").textContent = ""; }, 3000);
    } catch (e) {
      $("checkoutProxyStatus").textContent = "❌ Error saving";
      $("checkoutProxyStatus").style.color = "var(--error)";
    }
  };

  window.savePasswords = async function () {
    const adminPw = $("newAdminPw").value.trim();
    const userPw = $("newUserPw").value.trim();
    if (!adminPw && !userPw) return;
    try {
      await fetch("/api/admin/passwords", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminPassword: adminPw || undefined, userPassword: userPw || undefined }),
      });
      $("newAdminPw").value = "";
      $("newUserPw").value = "";
      alert("✅ Passwords updated!");
    } catch (e) { alert("Error!"); }
  };

  // ══════════════════════════════════════════════════════════════
  // ADDRESS MANAGEMENT
  // ══════════════════════════════════════════════════════════════
  async function loadAddresses() {
    try {
      const res = await fetch("/api/admin/addresses");
      const data = await res.json();
      renderAddresses(data.addresses || []);
    } catch (e) {}
  }

  function renderAddresses(addresses) {
    const list = $("addressList");
    if (addresses.length === 0) {
      list.innerHTML = '<div class="addr-empty">No addresses configured yet</div>';
      return;
    }
    list.innerHTML = addresses.map((a, i) => `
      <div class="addr-card">
        <div class="addr-card-header">
          <span class="addr-label">${a.label}</span>
          <div class="addr-actions">
            <button class="addr-btn addr-edit" onclick="editAddress(${i})" title="Edit">✏️</button>
            <button class="addr-btn addr-del" onclick="deleteAddress(${i})" title="Delete">🗑️</button>
          </div>
        </div>
        <div class="addr-detail">${a.name}</div>
        <div class="addr-detail addr-sub">${a.addressLine1}${a.addressLine2 ? ', ' + a.addressLine2 : ''}</div>
        <div class="addr-detail addr-sub">${a.city}, ${a.state ? a.state + ', ' : ''}${a.zip} — ${a.country}</div>
      </div>
    `).join("");
  }

  window.toggleAddressForm = function () {
    const form = $("addressForm");
    if (form.classList.contains("hidden")) {
      clearAddressForm();
      form.classList.remove("hidden");
    } else {
      form.classList.add("hidden");
    }
  };

  window.cancelAddressForm = function () {
    $("addressForm").classList.add("hidden");
    clearAddressForm();
  };

  function clearAddressForm() {
    $("addrLabel").value = "";
    $("addrName").value = "";
    $("addrCountry").value = "";
    $("addrLine1").value = "";
    $("addrLine2").value = "";
    $("addrCity").value = "";
    $("addrZip").value = "";
    $("addrState").innerHTML = '<option value="">State (if applicable)</option>';
    $("addrEditIndex").value = "-1";
    $("btnSaveAddr").textContent = "Save Address";
  }

  window.saveAddress = async function () {
    const addr = {
      label: $("addrLabel").value.trim(),
      name: $("addrName").value.trim(),
      country: $("addrCountry").value.trim(),
      addressLine1: $("addrLine1").value.trim(),
      addressLine2: $("addrLine2").value.trim(),
      city: $("addrCity").value.trim(),
      zip: $("addrZip").value.trim(),
      state: $("addrState").value.trim(),
    };
    if (!addr.name || !addr.country || !addr.addressLine1 || !addr.city || !addr.zip) {
      alert("Please fill required fields (Name, Country, Address, City, ZIP)");
      return;
    }

    const editIdx = parseInt($("addrEditIndex").value, 10);
    try {
      if (editIdx >= 0) {
        // Update
        await fetch(`/api/admin/addresses/${editIdx}`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(addr),
        });
      } else {
        // Create
        await fetch("/api/admin/addresses", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(addr),
        });
      }
      $("addressForm").classList.add("hidden");
      clearAddressForm();
      await loadAddresses();
    } catch (e) {
      alert("Error saving address");
    }
  };

  window.editAddress = async function (index) {
    try {
      const res = await fetch("/api/admin/addresses");
      const data = await res.json();
      const a = data.addresses[index];
      if (!a) return;
      $("addrLabel").value = a.label || "";
      $("addrName").value = a.name || "";
      $("addrCountry").value = a.country || "";
      // Populate states for this country then set value
      updateStateDropdown(a.country);
      $("addrLine1").value = a.addressLine1 || "";
      $("addrLine2").value = a.addressLine2 || "";
      $("addrCity").value = a.city || "";
      $("addrZip").value = a.zip || "";
      setTimeout(() => { $("addrState").value = a.state || ""; }, 100);
      $("addrEditIndex").value = index;
      $("btnSaveAddr").textContent = "Update Address";
      $("addressForm").classList.remove("hidden");
    } catch (e) {}
  };

  window.deleteAddress = async function (index) {
    if (!confirm("Delete this address?")) return;
    try {
      await fetch(`/api/admin/addresses/${index}`, { method: "DELETE" });
      await loadAddresses();
    } catch (e) { alert("Error deleting"); }
  };

  // ══════════════════════════════════════════════════════════════
  // TOGGLES
  // ══════════════════════════════════════════════════════════════
  $("offerToggle").querySelectorAll(".country-btn").forEach(b => {
    b.onclick = () => {
      $("offerToggle").querySelectorAll(".country-btn").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      state.offerCountry = b.dataset.country;
    };
  });

  $("billingToggle").querySelectorAll(".toggle-btn").forEach(b => {
    b.onclick = () => {
      $("billingToggle").querySelectorAll(".toggle-btn").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      state.billingCountry = b.dataset.country;
    };
  });

  $("modeToggle").querySelectorAll(".toggle-btn").forEach(b => {
    b.onclick = () => {
      $("modeToggle").querySelectorAll(".toggle-btn").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      state.mode = b.dataset.mode;
    };
  });

  // ── Clear ───────────────────────────────────────────────────
  $("btnClear").onclick = () => {
    $("sessionInput").value = "";
    state.accessToken = null;
    state.lastCheckoutUrl = null;
    $("resultSection").classList.add("hidden");
    $("gopayResultSection").classList.add("hidden");
    $("errorBar").classList.add("hidden");
    $("accountToast").classList.add("hidden");
    $("sessionInput").focus();
  };

  // ══════════════════════════════════════════════════════════════
  // GENERATE
  // ══════════════════════════════════════════════════════════════
  $("btnGenerate").onclick = generate;

  async function generate() {
    const raw = $("sessionInput").value.trim();
    if (!raw) return showError("Paste your session JSON first.");

    $("errorBar").classList.add("hidden");
    $("resultSection").classList.add("hidden");
    $("gopayResultSection").classList.add("hidden");

    let parseRes;
    try {
      parseRes = await fetch("/api/parse-session", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionData: raw }),
      }).then(r => r.json());
    } catch (e) { return showError("Parse error: " + e.message); }

    if (!parseRes.success) return showError(parseRes.error || "Parse failed.");

    state.accessToken = parseRes.info.accessToken;
    showAccountToast(parseRes.info);

    showLoader("Generating payment link...");
    $("btnGenerate").disabled = true;

    const userProxy = $("proxyInput").value.trim() || null;

    try {
      const res = await fetch("/api/generate-link", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessToken: state.accessToken,
          offerCountry: state.offerCountry,
          billingCountry: state.billingCountry,
          mode: state.mode,
          proxy: userProxy,
        }),
      });
      const data = await res.json();
      hideLoader();
      $("btnGenerate").disabled = false;

      if (!res.ok || !data.success) return showError(data.error || "Generation failed.");

      state.lastCheckoutUrl = data.link;

      $("resultLabel").textContent = state.mode === "hosted" ? "Hosted Payment Link" : "Embedded Checkout Link";
      $("resultLink").value = data.link;

      const meta = $("resultMeta");
      meta.innerHTML = "";
      [
        { l: "Offer", v: state.offerCountry },
        { l: "Billing", v: state.billingCountry },
        { l: "Mode", v: state.mode === "hosted" ? "Hosted" : "Embedded" },
        { l: "Promo", v: data.promoSkipped ? "Unavailable" : "✓ Applied" },
      ].forEach(({ l, v }) => {
        const d = document.createElement("div");
        d.className = "meta-chip";
        d.innerHTML = `<span class="meta-chip-label">${l}</span><span class="meta-chip-value">${v}</span>`;
        meta.appendChild(d);
      });

      $("resultSection").classList.remove("hidden");
      // Show auto-checkout button only for hosted mode
      $("btnAutoCheckout").classList.toggle("hidden", state.mode !== "hosted");
    } catch (e) {
      hideLoader();
      $("btnGenerate").disabled = false;
      showError("Error: " + e.message);
    }
  }

  // ══════════════════════════════════════════════════════════════
  // AUTO-CHECKOUT
  // ══════════════════════════════════════════════════════════════
  window.doAutoCheckout = async function () {
    const url = state.lastCheckoutUrl;
    if (!url) return showError("No checkout URL. Generate a link first.");

    showLoader("🚀 Opening Stripe checkout & filling form...");
    $("btnAutoCheckout").disabled = true;
    $("gopayResultSection").classList.add("hidden");

    try {
      const res = await fetch("/api/auto-checkout", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checkoutUrl: url }),
      });
      const data = await res.json();
      hideLoader();
      $("btnAutoCheckout").disabled = false;

      if (!res.ok || !data.success) {
        return showError(data.error || "Auto-checkout failed.");
      }

      // Show GoPay result
      const meta = $("gopayMeta");
      meta.innerHTML = "";
      [
        { l: "Address", v: data.addressUsed || "—" },
        { l: "Status", v: "✓ Success" },
      ].forEach(({ l, v }) => {
        const d = document.createElement("div");
        d.className = "meta-chip";
        d.innerHTML = `<span class="meta-chip-label">${l}</span><span class="meta-chip-value">${v}</span>`;
        meta.appendChild(d);
      });

      $("gopayLink").value = data.gopayUrl || "No GoPay URL captured";
      $("gopayResultSection").classList.remove("hidden");

    } catch (e) {
      hideLoader();
      $("btnAutoCheckout").disabled = false;
      showError("Auto-checkout error: " + e.message);
    }
  };

  // ── Copy ────────────────────────────────────────────────────
  $("btnCopy").onclick = async () => {
    const v = $("resultLink").value;
    if (!v) return;
    try { await navigator.clipboard.writeText(v); } catch { $("resultLink").select(); document.execCommand("copy"); }
    const btn = $("btnCopy");
    btn.classList.add("copied");
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
    setTimeout(() => {
      btn.classList.remove("copied");
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>`;
    }, 2000);
  };

  window.copyGopay = async function () {
    const v = $("gopayLink").value;
    if (!v) return;
    try { await navigator.clipboard.writeText(v); } catch { $("gopayLink").select(); document.execCommand("copy"); }
    const btn = $("btnCopyGopay");
    btn.classList.add("copied");
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
    setTimeout(() => {
      btn.classList.remove("copied");
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>`;
    }, 2000);
  };

  // ── Toast ───────────────────────────────────────────────────
  function showAccountToast(info) {
    $("tName").textContent = info.user.name;
    $("tEmail").textContent = info.user.email;
    const plan = (info.account.planType || "free").toLowerCase();
    const cls = plan === "plus" ? "plan-plus" : plan === "pro" ? "plan-pro" : "plan-free";
    $("tPlan").innerHTML = `<span class="plan-badge ${cls}">${plan.toUpperCase()}</span>`;
    $("tExpires").textContent = info.expires
      ? new Date(info.expires).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      : "—";
    $("accountToast").classList.remove("hidden");
  }

  $("toastClose").onclick = () => $("accountToast").classList.add("hidden");

  // ── Loader ─────────────────────────────────────────────────
  function showLoader(msg) {
    $("loaderText").textContent = msg || "Loading...";
    $("loader").classList.remove("hidden");
  }
  function hideLoader() {
    $("loader").classList.add("hidden");
  }

  // ── Error ───────────────────────────────────────────────────
  function showError(msg) {
    $("errorMessage").textContent = msg;
    $("errorBar").classList.remove("hidden");
    hideLoader();
    $("btnGenerate").disabled = false;
  }

  $("btnDismiss").onclick = () => $("errorBar").classList.add("hidden");

  // ── GoPay Activate ────────────────────────────────────────────
  window.doActivateGopay = async function () {
    const midtransUrl = $("gopayLink").value;
    if (!midtransUrl || !midtransUrl.includes("midtrans.com")) {
      alert("No valid Midtrans URL. Run Auto Checkout first.");
      return;
    }

    const btn = $("btnActivateGopay");
    const resultDiv = $("gopayActivateResult");
    const spinner = $("activateGopaySpinner");

    btn.disabled = true;
    spinner.classList.remove("hidden");
    resultDiv.className = "hidden";

    try {
      const res = await fetch("/api/gopay/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ midtransUrl }),
      });
      const data = await res.json();

      resultDiv.classList.remove("hidden");
      if (data.success) {
        resultDiv.style.background = "rgba(16,185,129,0.15)";
        resultDiv.style.color = "#10b981";
        resultDiv.innerHTML = `✅ GoPay activated! Captured ${data.capturedAPIs || 0} API calls.`;
      } else {
        resultDiv.style.background = "rgba(239,68,68,0.15)";
        resultDiv.style.color = "#ef4444";
        resultDiv.innerHTML = `❌ ${data.error || "Activation failed"}`;
      }
    } catch (err) {
      resultDiv.classList.remove("hidden");
      resultDiv.style.background = "rgba(239,68,68,0.15)";
      resultDiv.style.color = "#ef4444";
      resultDiv.innerHTML = `❌ ${err.message}`;
    } finally {
      btn.disabled = false;
      spinner.classList.add("hidden");
    }
  };

  // ── Cancel Subscription ────────────────────────────────────────
  window.doCancelSub = async function () {
    const sessionJson = $("sessionInput").value.trim();
    if (!sessionJson) {
      alert("Session JSON is required to cancel subscription.");
      return;
    }

    // Extract access token from session JSON
    let accessToken;
    try {
      const parsed = JSON.parse(sessionJson);
      accessToken = parsed.accessToken || parsed.access_token || sessionJson;
    } catch {
      accessToken = sessionJson;
    }

    const btn = $("btnCancelSub");
    const resultDiv = $("cancelSubResult");
    const spinner = $("cancelSubSpinner");

    btn.disabled = true;
    spinner.classList.remove("hidden");
    resultDiv.className = "hidden";

    try {
      const res = await fetch("/api/cancel-subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken }),
      });
      const data = await res.json();

      resultDiv.classList.remove("hidden");
      if (data.success) {
        resultDiv.style.background = "rgba(16,185,129,0.15)";
        resultDiv.style.color = "#10b981";
        resultDiv.innerHTML = "✅ Subscription cancelled!";
      } else {
        resultDiv.style.background = "rgba(239,68,68,0.15)";
        resultDiv.style.color = "#ef4444";
        resultDiv.innerHTML = `❌ ${data.error || "Cancel failed"}`;
      }
    } catch (err) {
      resultDiv.classList.remove("hidden");
      resultDiv.style.background = "rgba(239,68,68,0.15)";
      resultDiv.style.color = "#ef4444";
      resultDiv.innerHTML = `❌ ${err.message}`;
    } finally {
      btn.disabled = false;
      spinner.classList.add("hidden");
    }
  };

  // ── Init ────────────────────────────────────────────────────
  checkAuth();

})();
