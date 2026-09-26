// patient.js — RapidAid Patient Wizard
// Handles smooth step transitions, 6-box OTP, severity selection, SOS dispatch

const socket = io({ transports: ["polling"] });
let verifiedPhone = null;
let liveTrackingWatchId = null;
let currentStepId = 'phoneStep';

// Progress percentages per step
const PROGRESS = {
  phoneStep:   0,
  otpStep:    30,
  sosStep:    65,
  waitingStep: 85,
  assignedStep: 100,
};

/* ════════════════════════════════════════════
   STEP TRANSITIONS
   ════════════════════════════════════════════ */
function show(id) {
  if (currentStepId === id) return;
  const prev = document.getElementById(currentStepId);
  const next = document.getElementById(id);
  if (!prev || !next) return;

  // Slide previous step out
  prev.classList.add('slide-exit');
  setTimeout(() => {
    prev.classList.remove('active', 'slide-exit');
    // Slide next step in
    next.classList.add('active');
    currentStepId = id;
    // Scroll to top in case of small screens
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, 280);

  // Update progress bar
  const fill = document.getElementById('progressFill');
  if (fill) fill.style.width = (PROGRESS[id] ?? 0) + '%';
}

/* ════════════════════════════════════════════
   6-BOX OTP HANDLER
   ════════════════════════════════════════════ */
const otpBoxEls = Array.from(document.querySelectorAll('.otp-box'));
const otpHiddenInput = document.getElementById('otpInput');

otpBoxEls.forEach((box, i) => {
  // Allow only digits
  box.addEventListener('keydown', (e) => {
    if (['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.key)) return;
    if (!/^\d$/.test(e.key)) e.preventDefault();
  });

  box.addEventListener('input', (e) => {
    const raw = e.target.value.replace(/\D/g, '');
    box.value = raw ? raw[raw.length - 1] : '';  // keep last digit only
    box.classList.toggle('filled', !!box.value);

    if (box.value && i < 5) otpBoxEls[i + 1].focus();

    syncOtp();
  });

  box.addEventListener('keyup', (e) => {
    if (e.key === 'Backspace' && !box.value && i > 0) {
      otpBoxEls[i - 1].focus();
      otpBoxEls[i - 1].value = '';
      otpBoxEls[i - 1].classList.remove('filled');
      syncOtp();
    }
  });

  // Paste entire code into first box
  box.addEventListener('paste', (e) => {
    e.preventDefault();
    const pasted = (e.clipboardData || window.clipboardData)
      .getData('text').replace(/\D/g, '').slice(0, 6);
    pasted.split('').forEach((ch, idx) => {
      if (otpBoxEls[idx]) {
        otpBoxEls[idx].value = ch;
        otpBoxEls[idx].classList.add('filled');
      }
    });
    syncOtp();
    if (pasted.length === 6) {
      otpBoxEls[5].focus();
      scheduleAutoVerify();
    }
  });
});

function syncOtp() {
  const full = otpBoxEls.map(b => b.value).join('');
  otpHiddenInput.value = full;
  verifyOtpBtn.disabled = full.length < 6;
  if (full.length === 6) scheduleAutoVerify();
}

function fillOtpBoxes(code) {
  code.split('').forEach((ch, i) => {
    if (otpBoxEls[i]) {
      otpBoxEls[i].value = ch;
      otpBoxEls[i].classList.add('filled');
    }
  });
  otpHiddenInput.value = code;
  verifyOtpBtn.disabled = false;
}

function clearOtpBoxes() {
  otpBoxEls.forEach(b => { b.value = ''; b.classList.remove('filled'); });
  otpHiddenInput.value = '';
  verifyOtpBtn.disabled = true;
}

let autoVerifyTimer = null;
function scheduleAutoVerify() {
  clearTimeout(autoVerifyTimer);
  autoVerifyTimer = setTimeout(() => triggerVerify(otpHiddenInput.value), 500);
}

/* ════════════════════════════════════════════
   BUTTON REFERENCES
   ════════════════════════════════════════════ */
const sendOtpBtn   = document.getElementById('sendOtpBtn');
const verifyOtpBtn = document.getElementById('verifyOtpBtn');
const changePhoneBtn = document.getElementById('changePhoneBtn');

/* ════════════════════════════════════════════
   STEP 1 — PHONE
   ════════════════════════════════════════════ */
const phoneInput = document.getElementById('phoneInput');

// Restrict to digits only
phoneInput.addEventListener('input', () => {
  phoneInput.value = phoneInput.value.replace(/\D/g, '');
});
phoneInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendOtpBtn.click();
});

sendOtpBtn.onclick = () => {
  const phone = phoneInput.value.trim();
  if (phone.length !== 10 || !/^\d{10}$/.test(phone)) {
    document.getElementById('phoneError').innerText = 'Enter a valid 10-digit number';
    shakeEl(document.querySelector('.input-group'));
    return;
  }
  document.getElementById('phoneError').innerText = '';
  sendOtpBtn.disabled = true;
  sendOtpBtn.querySelector('.btn-text').innerText = 'Sending…';
  socket.emit('auth:request-otp', { phone });
};

/* ════════════════════════════════════════════
   STEP 2 — OTP
   ════════════════════════════════════════════ */
socket.on('auth:otp-sent', ({ phone, devOtp, smsDelivered, warning }) => {
  // Reset Send OTP button
  sendOtpBtn.disabled = false;
  sendOtpBtn.querySelector('.btn-text').innerText = 'Send OTP';
  document.getElementById('phoneError').innerText = '';
  verifiedPhone = phone;

  const hint   = document.getElementById('otpHint');
  const banner = document.getElementById('devOtpBanner');
  clearOtpBoxes();
  document.getElementById('otpError').innerText = '';

  if (!smsDelivered && devOtp) {
    // Fast2SMS not charged — dev fallback mode
    hint.innerText = 'Fast2SMS gateway requires ₹100 wallet recharge — test mode active.';
    banner.style.display = 'block';
    banner.innerHTML = `
      <strong style="display:block;margin-bottom:6px;">⚡ Test Mode — SMS Gateway Offline</strong>
      Fast2SMS needs an account recharge of ₹100+ to deliver live SMS.<br/>
      Your OTP for testing:
      <strong style="font-size:22px;letter-spacing:5px;color:#fff;display:inline-block;margin:6px 0;">${devOtp}</strong><br/>
      <span style="font-size:11px;opacity:0.65;">(Code is also printed in your terminal server logs)</span>
    `;
    fillOtpBoxes(devOtp);
  } else {
    banner.style.display = 'none';
    hint.innerText = `OTP sent via SMS to +91 ${phone}.`;
  }

  show('otpStep');
  // Focus first empty box after animation settles
  setTimeout(() => {
    const firstEmpty = otpBoxEls.find(b => !b.value) || otpBoxEls[0];
    firstEmpty.focus();
  }, 450);
});

verifyOtpBtn.onclick = () => triggerVerify(otpHiddenInput.value);

function triggerVerify(code) {
  if (!code || code.length < 6) {
    document.getElementById('otpError').innerText = 'Enter the complete 6-digit OTP';
    shakeEl(document.getElementById('otpBoxes'));
    return;
  }
  clearTimeout(autoVerifyTimer);
  verifyOtpBtn.disabled = true;
  verifyOtpBtn.querySelector('.btn-text').innerText = 'Verifying…';
  document.getElementById('otpError').innerText = '';
  socket.emit('auth:verify-otp', { phone: verifiedPhone, code });
}

socket.on('auth:verified', () => {
  verifyOtpBtn.disabled = false;
  verifyOtpBtn.querySelector('.btn-text').innerText = 'Verify Code';
  show('sosStep');
});

socket.on('auth:error', (msg) => {
  sendOtpBtn.disabled = false;
  sendOtpBtn.querySelector('.btn-text').innerText = 'Send OTP';
  verifyOtpBtn.disabled = false;
  verifyOtpBtn.querySelector('.btn-text').innerText = 'Verify Code';
  document.getElementById('phoneError').innerText = msg;
  document.getElementById('otpError').innerText = msg;
  shakeEl(document.getElementById('otpBoxes'));
  clearOtpBoxes();
});

changePhoneBtn.onclick = () => {
  clearOtpBoxes();
  document.getElementById('otpError').innerText = '';
  show('phoneStep');
};

/* ════════════════════════════════════════════
   STEP 3 — SOS FORM
   ════════════════════════════════════════════ */

// Severity card picker
document.querySelectorAll('.severity-option').forEach(opt => {
  opt.addEventListener('click', () => {
    document.querySelectorAll('.severity-option').forEach(o => o.classList.remove('selected'));
    opt.classList.add('selected');
    document.getElementById('severityInput').value = opt.dataset.value;
  });
});

// Digits-only for emergency contact
document.getElementById('contactInput').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '');
});

document.getElementById('sosBtn').onclick = () => {
  const contact  = document.getElementById('contactInput').value.trim();
  const severity = document.getElementById('severityInput').value;
  const sosNote  = document.getElementById('sosNote');
  sosNote.innerText = '📍 Getting your location…';

  if (!navigator.geolocation) {
    sendSOSFallback(severity, contact);
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      socket.emit('sos:report', {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        severity,
        emergencyContact: contact || undefined,
      });
      show('waitingStep');
    },
    () => sendSOSFallback(severity, contact),
    { enableHighAccuracy: true, timeout: 8000 }
  );
};

function sendSOSFallback(severity, contact) {
  socket.emit('sos:report', {
    lat: 11.0168, lng: 76.9558,
    severity,
    emergencyContact: contact || undefined,
  });
  show('waitingStep');
}

/* ════════════════════════════════════════════
   STEP 4 & 5 — WAITING → ASSIGNED
   ════════════════════════════════════════════ */
socket.on('sos:assignment', ({ hospital, ambulanceId, etaMinutes, incidentId }) => {
  document.getElementById('assignedHospital').innerHTML =
    `🏥 <strong>Hospital:</strong> ${hospital}`;
  document.getElementById('assignedAmbulance').innerHTML =
    `🚑 <strong>Ambulance:</strong> ${ambulanceId}`;
  document.getElementById('assignedEta').innerHTML =
    `⏱ ETA: ~${etaMinutes} min`;

  const trackBtn = document.getElementById('trackLinkBtn');
  if (trackBtn && incidentId) {
    trackBtn.href = `track.html?id=${incidentId}`;
  }

  show('assignedStep');
  startLiveTracking();
});

socket.on('sos:queued', ({ message }) => {
  document.getElementById('waitingMsg').innerText = message;
});

function startLiveTracking() {
  if (liveTrackingWatchId || !navigator.geolocation) return;
  liveTrackingWatchId = navigator.geolocation.watchPosition(
    (pos) => socket.emit('patient:location', {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
    }),
    (err) => console.warn('Live tracking GPS error:', err),
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 8000 }
  );
}

/* ════════════════════════════════════════════
   UTILITY
   ════════════════════════════════════════════ */
function shakeEl(el) {
  if (!el) return;
  el.classList.remove('shake');
  void el.offsetWidth; // force reflow
  el.classList.add('shake');
  el.addEventListener('animationend', () => el.classList.remove('shake'), { once: true });
}
