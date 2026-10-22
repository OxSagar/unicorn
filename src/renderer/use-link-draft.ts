import { useCallback, useEffect, useRef, useState } from 'react';

const DRAFT_KEY = 'unicorn.link-draft.v1';
const DRAFT_LIMIT = 2_000_000;
const OVERSIZE_MESSAGE =
  'This saved draft is over 2 million characters. Its text has been preserved; shorten it before distributing.';

function readDraft(): { text: string; error?: string } {
  try {
    return { text: window.localStorage.getItem(DRAFT_KEY) ?? '' };
  } catch {
    return { text: '', error: 'Your saved links could not be read. Local storage may be unavailable.' };
  }
}

export function useLinkDraft() {
  const [initial] = useState(readDraft);
  const [text, setText] = useState(initial.text);
  const [storageError, setStorageError] = useState(initial.error);
  const [inputError, setInputError] = useState(
    initial.text.length > DRAFT_LIMIT ? OVERSIZE_MESSAGE : undefined,
  );
  const [saved, setSaved] = useState(!initial.error);
  const current = useRef(text);
  const dirty = useRef(false);

  const persist = useCallback((report = true) => {
    if (!dirty.current) return;
    try {
      if (current.current) window.localStorage.setItem(DRAFT_KEY, current.current);
      else window.localStorage.removeItem(DRAFT_KEY);
      dirty.current = false;
      if (report) {
        setSaved(true);
        setStorageError(undefined);
      }
    } catch {
      if (report) {
        setSaved(false);
        setStorageError('Your links could not be saved locally. Copy them before closing Unicorn.');
      }
    }
  }, []);

  const update = (next: string): boolean => {
    if (next.length > DRAFT_LIMIT && next.length >= current.current.length) {
      setInputError(
        'The list is too large. Your previous text was kept; paste no more than 2 million characters.',
      );
      return false;
    }
    // An oversized saved draft may be shortened gradually without losing its text.
    current.current = next;
    dirty.current = true;
    setText(next);
    setSaved(false);
    setInputError(next.length > DRAFT_LIMIT ? OVERSIZE_MESSAGE : undefined);
    return true;
  };

  useEffect(() => {
    const timer = window.setTimeout(() => persist(), 250);
    return () => window.clearTimeout(timer);
  }, [text, persist]);

  useEffect(() => {
    const flush = () => persist(false);
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [persist]);

  return {
    text,
    current,
    update,
    persist,
    saved,
    error: inputError || storageError,
    tooLarge: text.length > DRAFT_LIMIT,
  };
}
