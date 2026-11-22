  // ---------- prefilled load: jump past what's already answered ----------
  // On reload/reopen with saved answers, scroll to the first unanswered
  // question so the user doesn't re-scan questions they already did.
  if (initialPrefill && QS.length) {
    const answered = QS.filter((q) => getValue(q) !== undefined).length;
    const firstOpen = QS.find((q) => getValue(q) === undefined);
    if (answered > 0 && firstOpen) {
      setTimeout(() => {
        cards[firstOpen.id].scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 350);
    }
  }

  // If the chosen prefill came from the local mirror (newer than the server, or
  // the server had nothing — e.g. a freshly reopened board the user had typed
  // into in another tab during an outage), the server doesn't yet have this
  // input. Flush it once so a brand-new tab's view is also the server's truth.
  if (initialPrefill && initialPrefill.__from === 'local' && !submitted && canPersistFeedback) {
    saveDraft();
  }

