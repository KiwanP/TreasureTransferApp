// App.tsx
// @ts-nocheck
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  SafeAreaView,
  StyleSheet,
  View,
  Text,
  TextInput,
  Button,
  Alert,
  ActivityIndicator,
  Pressable,
  ScrollView,
  Platform,
  Linking,
  AppState,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NfcManager, {
  Ndef,
  NfcEvents,
  NfcAdapter,
  NfcTech,
} from 'react-native-nfc-manager';
import {
  HCESession,
  NFCTagType4,
  NFCTagType4NDEFContentType,
} from 'react-native-hce';
import { API_BASE } from '@env';

const BOTTOM_NAV_PADDING = Platform.OS === 'android' ? 72 : 32;
const BASE_URL = API_BASE || 'http://localhost:5000/api';
const WEB_BASE = BASE_URL.replace(/\/api\/?$/, '');
const TOKEN_KEY = '@treasure_token';
const EMAIL_KEY = '@treasure_email';
const TRANSFER_URI_PREFIX = 'treasuretransfer://transfer?data=';
const INVITE_APP_URI_PREFIX = 'treasuretransfer://invite/';
const INVITE_URI_PATTERN = /\/invite\/([a-f0-9]{32})(?:[/?#]|$)/i;

/** NFC HCE payload — 커스텀 URI만 (https 2레코드는 일부 기기 HCE 오류 유발) */
function buildInviteNfcContent(_inviteUrl: string, inviteToken: string): string {
  return `${INVITE_APP_URI_PREFIX}${inviteToken}`;
}
const NFC_READER_RECEIVE_OPTS = {
  isReaderModeEnabled: true,
  readerModeFlags:
    NfcAdapter.FLAG_READER_NFC_A |
    NfcAdapter.FLAG_READER_NFC_B |
    NfcAdapter.FLAG_READER_NO_PLATFORM_SOUNDS,
  invalidateAfterFirstRead: false,
  // 기본값 10초는 재인식까지 너무 길어, 짧은 태그에 실패하기 쉬움
  readerModeDelay: 0,
};
const HCE_WARMUP_MS = 500;
const HCE_STOP_DELAY_MS = 250;
const NFC_DEDUPE_MS = 3000;

let hceReadUnsub: (() => void) | null = null;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isSenderNfcMode(currentScreen: Screen, pushing: boolean): boolean {
  return currentScreen === 'send' || pushing;
}

type TransferPayload = {
  type: 'TRANSFER';
  amount: number;
  fromEmail: string;
  inviteToken?: string;
};
type Screen =
  | 'login'
  | 'register'
  | 'home'
  | 'purchase'
  | 'send'
  | 'receive';

function authHeaders(token: string) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

const API_TIMEOUT_MS = 150000;
const API_RETRY_COUNT = 3;
const API_RETRY_DELAY_MS = 3000;

async function fetchJson(
  url: string,
  options: RequestInit = {},
): Promise<{ res: Response; data: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error(
        '서버 응답 시간 초과. Render 무료 플랜은 첫 요청에 1~2분 걸릴 수 있습니다.',
      );
    }
    throw new Error('네트워크 연결 실패. Wi-Fi/LTE를 확인해주세요.');
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonWithRetry(
  url: string,
  options: RequestInit = {},
): Promise<{ res: Response; data: any }> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= API_RETRY_COUNT; attempt += 1) {
    try {
      return await fetchJson(url, options);
    } catch (err: any) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < API_RETRY_COUNT) {
        await new Promise(resolve => setTimeout(resolve, API_RETRY_DELAY_MS));
      }
    }
  }
  throw lastError ?? new Error('서버 요청 실패');
}

async function warmUpApi(): Promise<void> {
  try {
    await fetchJson(`${BASE_URL}/health`);
  } catch {
    // Render 슬립 해제 시도; 실패해도 본 흐름은 계속
  }
}

async function sendToBackend(
  token: string,
  payload: TransferPayload,
): Promise<number> {
  if (payload.inviteToken) {
    const { res, data } = await fetchJsonWithRetry(
      `${BASE_URL}/transfer/invite/${payload.inviteToken}/claim`,
      {
        method: 'POST',
        headers: authHeaders(token),
      },
    );
    if (!res.ok) {
      throw new Error(data.message || `Status ${res.status}`);
    }
    return data.balance;
  }

  throw new Error('지원하지 않는 전송 형식입니다. 앱을 업데이트해 주세요.');
}

async function fetchInviteDetails(token: string): Promise<TransferPayload> {
  const { res, data } = await fetchJsonWithRetry(
    `${BASE_URL}/transfer/invite/${token}`,
  );
  if (!res.ok) {
    throw new Error(data.message || 'Invite not found');
  }
  if (data.status !== 'pending') {
    throw new Error(
      data.status === 'claimed'
        ? '이미 수령된 보물입니다.'
        : '만료되었거나 취소된 초대입니다.',
    );
  }
  return {
    type: 'TRANSFER',
    amount: data.amount,
    fromEmail: data.fromEmail,
    inviteToken: token,
  };
}

async function createTransferInvite(
  token: string,
  amount: number,
): Promise<{
  inviteToken: string;
  inviteUrl: string;
  senderBalance: number;
}> {
  const { res, data } = await fetchJsonWithRetry(`${BASE_URL}/transfer/invite`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ amount }),
  });
  if (!res.ok) {
    throw new Error(data.message || 'Failed to create invite');
  }
  return {
    inviteToken: data.inviteToken,
    inviteUrl: data.inviteUrl,
    senderBalance: data.senderBalance,
  };
}

async function cancelTransferInvite(
  authToken: string,
  inviteToken: string,
): Promise<number | null> {
  try {
    const { res, data } = await fetchJson(
      `${BASE_URL}/transfer/invite/${inviteToken}/cancel`,
      {
        method: 'POST',
        headers: authHeaders(authToken),
      },
    );
    if (res.ok) {
      return data.balance;
    }
  } catch {
    // 취소 실패는 무시
  }
  return null;
}

function validateTransferPayload(payload: any): TransferPayload | null {
  if (
    payload?.type === 'TRANSFER' &&
    typeof payload.amount === 'number' &&
    typeof payload.fromEmail === 'string' &&
    payload.fromEmail.length > 0
  ) {
    return payload;
  }
  return null;
}

function buildTransferUri(payload: TransferPayload): string {
  return `${TRANSFER_URI_PREFIX}${encodeURIComponent(JSON.stringify(payload))}`;
}

function parseInviteTokenFromUri(uri: string): string | null {
  const match = uri.match(INVITE_URI_PATTERN);
  return match ? match[1] : null;
}

function parseNdefRecords(
  tag: any,
): { inviteToken?: string; legacy?: TransferPayload } | null {
  if (!tag?.ndefMessage?.length) {
    return null;
  }

  for (const record of tag.ndefMessage) {
    try {
      const uri = Ndef.uri.decodePayload(record.payload);
      const inviteToken = parseInviteTokenFromUri(uri);
      if (inviteToken) {
        return { inviteToken };
      }
      const fromUri = parseTransferUri(uri);
      if (fromUri) {
        return { legacy: fromUri };
      }
    } catch {
      // URI record가 아니면 text 방식 시도
    }

    try {
      const text = Ndef.text.decodePayload(record.payload);
      const inviteToken = parseInviteTokenFromUri(text);
      if (inviteToken) {
        return { inviteToken };
      }
      const payload = JSON.parse(text);
      const legacy = validateTransferPayload(payload);
      if (legacy) {
        return { legacy };
      }
    } catch {
      // 다음 레코드
    }
  }

  return null;
}

async function resolveNdefRecords(
  parsed: { inviteToken?: string; legacy?: TransferPayload } | null,
): Promise<TransferPayload | null> {
  if (!parsed) {
    return null;
  }
  if (parsed.legacy) {
    return parsed.legacy;
  }
  if (parsed.inviteToken) {
    return fetchInviteDetails(parsed.inviteToken);
  }
  return null;
}

function parseTransferUri(uri: string): TransferPayload | null {
  if (!uri.startsWith(TRANSFER_URI_PREFIX)) {
    return null;
  }
  try {
    const payload = JSON.parse(
      decodeURIComponent(uri.slice(TRANSFER_URI_PREFIX.length)),
    );
    return validateTransferPayload(payload);
  } catch {
    return null;
  }
}

async function resolveTagToPayload(
  initialTag: any,
  busyRef: { current: boolean },
): Promise<TransferPayload | null> {
  const fromCache = parseNdefRecords(initialTag);
  const resolved = await resolveNdefRecords(fromCache);
  if (resolved) {
    return resolved;
  }

  if (busyRef.current) {
    return null;
  }
  busyRef.current = true;

  try {
    for (const tech of [NfcTech.Ndef, NfcTech.IsoDep]) {
      try {
        await NfcManager.requestTechnology(tech);
        let tag = await NfcManager.getTag();
        let parsed = parseNdefRecords(tag);
        let payload = await resolveNdefRecords(parsed);
        if (payload) {
          return payload;
        }

        try {
          tag = await NfcManager.ndefHandler.getNdefMessage();
          parsed = parseNdefRecords(tag);
          payload = await resolveNdefRecords(parsed);
          if (payload) {
            return payload;
          }
        } catch {
          // cached NDEF가 비어 있을 때 active read 시도
        }
      } catch {
        // 다음 tech로 재시도
      } finally {
        await NfcManager.cancelTechnologyRequest().catch(() => {});
      }
    }
  } finally {
    busyRef.current = false;
  }

  return null;
}

async function stopNfcPush(session: HCESession | null): Promise<void> {
  if (hceReadUnsub) {
    hceReadUnsub();
    hceReadUnsub = null;
  }
  try {
    const activeSession =
      session ?? (await HCESession.getInstance().catch(() => null));
    if (activeSession) {
      await activeSession.setEnabled(false);
    }
  } catch (err) {
    console.warn('HCE 세션 종료 오류', err);
  }
  await delay(HCE_STOP_DELAY_MS);
}

async function startNfcPush(
  nfcContentUrl: string,
  onRead?: () => void,
): Promise<HCESession> {
  await stopNfcPush(null);

  const tag = new NFCTagType4({
    type: NFCTagType4NDEFContentType.URL,
    content: nfcContentUrl,
    writable: false,
  });

  const session = await HCESession.getInstance();
  await session.setApplication(tag);
  await session.setEnabled(true);
  await delay(HCE_WARMUP_MS);

  if (onRead) {
    hceReadUnsub = session.on(HCESession.Events.HCE_STATE_READ, onRead);
  }

  return session;
}

function isSendFinishedStatus(status: string): boolean {
  return /전송\s*완료/.test(status);
}

async function ensureNfcReady(): Promise<boolean> {
  const supported = await NfcManager.isSupported();
  if (!supported) {
    Alert.alert('NFC 미지원', '이 기기는 NFC를 지원하지 않습니다.');
    return false;
  }
  const enabled = await NfcManager.isEnabled();
  if (!enabled) {
    Alert.alert('NFC 비활성', '설정에서 NFC를 켜주세요.');
    return false;
  }
  return true;
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('login');
  const [booting, setBooting] = useState(true);
  const [token, setToken] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string>('');
  const [walletCount, setWalletCount] = useState<number>(0);
  const [emailInput, setEmailInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [purchaseAmount, setPurchaseAmount] = useState<string>('0');
  const [transferAmount, setTransferAmount] = useState<string>('0');
  const [isPushing, setIsPushing] = useState(false);
  const [pushStarting, setPushStarting] = useState(false);
  const [pushReadComplete, setPushReadComplete] = useState(false);
  const [pushComplete, setPushComplete] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [nfcStatus, setNfcStatus] = useState<string>('');
  const [authLoading, setAuthLoading] = useState(false);
  const [purchaseLoading, setPurchaseLoading] = useState(false);
  const [receiveLoading, setReceiveLoading] = useState(false);
  const [walletLoading, setWalletLoading] = useState(false);
  const [incomingPayload, setIncomingPayload] = useState<TransferPayload | null>(
    null,
  );

  const hceSessionRef = useRef<HCESession | null>(null);
  const listeningRef = useRef(false);
  const tokenRef = useRef<string | null>(null);
  const receiveBusyRef = useRef(false);
  const walletLoadingRef = useRef(false);
  const balanceBeforePushRef = useRef(0);
  const transferAmountAtPushRef = useRef(0);
  const pushPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sendFinishedRef = useRef(false);
  const isPushingRef = useRef(false);
  const pendingPayloadRef = useRef<TransferPayload | null>(null);
  const screenRef = useRef<Screen>('login');
  const presentIncomingTransferRef = useRef<(payload: TransferPayload) => void>(
    () => {},
  );
  const nfcRegisterRef = useRef<
    ((senderMode: boolean) => Promise<void>) | null
  >(null);
  const nfcSenderModeRef = useRef<boolean | null>(null);
  const ndefReadBusyRef = useRef(false);
  const lastNfcPayloadRef = useRef<{ key: string; at: number } | null>(null);
  const activeInviteTokenRef = useRef<string | null>(null);
  const forceNfcResyncRef = useRef<(() => Promise<void>) | null>(null);
  const [nfcTapHint, setNfcTapHint] = useState('');

  useEffect(() => {
    screenRef.current = screen;
  }, [screen]);

  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  useEffect(() => {
    isPushingRef.current = isPushing;
  }, [isPushing]);

  const persistSession = async (newToken: string, email: string) => {
    await AsyncStorage.setMany({
      [TOKEN_KEY]: newToken,
      [EMAIL_KEY]: email,
    });
    setToken(newToken);
    setUserEmail(email);
  };

  const clearSession = async () => {
    await AsyncStorage.removeMany([TOKEN_KEY, EMAIL_KEY]);
    setToken(null);
    setUserEmail('');
    setWalletCount(0);
    setScreen('login');
  };

  const fetchWallet = useCallback(async (showResult = false) => {
    const activeToken = tokenRef.current;
    if (!activeToken || walletLoadingRef.current) {
      return;
    }
    walletLoadingRef.current = true;
    setWalletLoading(true);
    try {
      const { res, data } = await fetchJsonWithRetry(`${BASE_URL}/wallet`, {
        headers: authHeaders(activeToken),
      });
      if (res.status === 401 || res.status === 403) {
        clearSession();
        throw new Error('Session expired');
      }
      if (!res.ok) {
        throw new Error(data.message || `Status ${res.status}`);
      }
      setWalletCount(data.balance);
      setUserEmail(data.email);
      if (showResult) {
        Alert.alert('잔액 갱신', `서버 잔액: ${data.balance}개`);
      }
    } catch (err: any) {
      console.warn('지갑 조회 실패', err);
      if (showResult && tokenRef.current) {
        Alert.alert(
          '서버 연결 실패',
          err.message || 'API 주소와 네트워크 연결을 확인해주세요.',
        );
      }
    } finally {
      walletLoadingRef.current = false;
      setWalletLoading(false);
    }
  }, []);

  useEffect(() => {
    NfcManager.start()
      .then(() => console.log('NFC Manager started'))
      .catch((err: any) => console.warn('NFC 초기화 실패', err));

    AsyncStorage.getMany([TOKEN_KEY, EMAIL_KEY])
      .then(saved => {
        const savedToken = saved[TOKEN_KEY];
        const savedEmail = saved[EMAIL_KEY];
        if (savedToken && savedEmail) {
          setToken(savedToken);
          setUserEmail(savedEmail);
          tokenRef.current = savedToken;
          setScreen('home');
        }
      })
      .finally(() => setBooting(false));

    return () => {
      const tok = tokenRef.current;
      const inviteTok = activeInviteTokenRef.current;
      if (tok && inviteTok && !sendFinishedRef.current) {
        cancelTransferInvite(tok, inviteTok).catch(() => {});
      }
      stopNfcPush(hceSessionRef.current);
      NfcManager.setEventListener(NfcEvents.DiscoverTag, null);
      NfcManager.unregisterTagEvent().catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!token || booting) {
      return;
    }

    let cancelled = false;

    const applyIncomingPayload = (payload: TransferPayload) => {
      const dedupeKey = payload.inviteToken
        ? `invite:${payload.inviteToken}`
        : `${payload.fromEmail}:${payload.amount}`;
      const now = Date.now();
      const last = lastNfcPayloadRef.current;
      if (
        last &&
        last.key === dedupeKey &&
        now - last.at < NFC_DEDUPE_MS &&
        (listeningRef.current || screenRef.current === 'receive')
      ) {
        return;
      }
      lastNfcPayloadRef.current = { key: dedupeKey, at: now };
      setNfcTapHint('');

      if (listeningRef.current || screenRef.current === 'receive') {
        presentIncomingTransferRef.current(payload);
        return;
      }

      pendingPayloadRef.current = payload;
      setScreen('receive');
    };

    const onTagDiscovered = (tag: any) => {
      if (screenRef.current === 'send' || isPushingRef.current) {
        return;
      }
      if (receiveBusyRef.current) {
        return;
      }

      void (async () => {
        try {
          const payload = await resolveTagToPayload(tag, ndefReadBusyRef);
          if (cancelled || !payload) {
            if (!cancelled && !payload) {
              setNfcTapHint(
                '인식됐지만 데이터를 읽지 못했습니다. 등을 1~2초 더 유지해 주세요.',
              );
            }
            return;
          }
          applyIncomingPayload(payload);
        } catch (err: any) {
          console.warn('NFC 태그 처리 오류', err);
          if (!cancelled) {
            setNfcTapHint(err.message || '초대 정보를 불러오지 못했습니다.');
          }
        } finally {
          ndefReadBusyRef.current = false;
          if (
            !cancelled &&
            !isSenderNfcMode(screenRef.current, isPushingRef.current)
          ) {
            await forceNfcResyncRef.current?.().catch(() => {});
          }
        }
      })();
    };

    nfcRegisterRef.current = async (senderMode: boolean) => {
      NfcManager.setEventListener(NfcEvents.DiscoverTag, null);
      await NfcManager.unregisterTagEvent().catch(() => {});
      if (cancelled) {
        return;
      }

      // 보내기 화면/HCE 전송 중에는 registerTagEvent({})를 쓰면
      // 포그라운드 디스패치가 켜져 '앱 선택'·'다시 태그' 안내가 뜨고 HCE가 막힘
      if (senderMode) {
        return;
      }

      NfcManager.setEventListener(NfcEvents.DiscoverTag, onTagDiscovered);
      await NfcManager.registerTagEvent(NFC_READER_RECEIVE_OPTS).catch(
        (err: any) => {
          console.warn('NFC 리스닝 시작 오류', err);
          nfcSenderModeRef.current = null;
        },
      );
    };

    forceNfcResyncRef.current = async () => {
      if (cancelled || !nfcRegisterRef.current) {
        return;
      }
      const senderMode = isSenderNfcMode(
        screenRef.current,
        isPushingRef.current,
      );
      nfcSenderModeRef.current = null;
      nfcSenderModeRef.current = senderMode;
      await nfcRegisterRef.current(senderMode);
    };

    return () => {
      cancelled = true;
      nfcRegisterRef.current = null;
      nfcSenderModeRef.current = null;
      NfcManager.setEventListener(NfcEvents.DiscoverTag, null);
      NfcManager.unregisterTagEvent().catch(() => {});
    };
  }, [token, booting]);

  useEffect(() => {
    if (!token || booting || !nfcRegisterRef.current) {
      return;
    }

    const senderMode = isSenderNfcMode(screen, isPushing);
    if (nfcSenderModeRef.current === senderMode) {
      return;
    }

    nfcSenderModeRef.current = senderMode;
    nfcRegisterRef.current(senderMode).catch((err: any) => {
      console.warn('NFC 모드 전환 오류', err);
    });
  }, [token, booting, screen, isPushing]);

  const resetForNextTransfer = useCallback(async () => {
    lastNfcPayloadRef.current = null;
    ndefReadBusyRef.current = false;
    receiveBusyRef.current = false;
    pendingPayloadRef.current = null;
    setIncomingPayload(null);
    setPushStarting(false);
    await forceNfcResyncRef.current?.().catch(() => {});
  }, []);

  useEffect(() => {
    if (!token || booting) {
      return;
    }
    if (screen === 'home' && !isPushing && !pushStarting) {
      resetForNextTransfer();
    }
  }, [token, booting, screen, isPushing, pushStarting, resetForNextTransfer]);

  useEffect(() => {
    if (!token) {
      return;
    }
    const sub = AppState.addEventListener('change', nextState => {
      if (
        nextState === 'active' &&
        screenRef.current === 'home' &&
        !isPushingRef.current
      ) {
        forceNfcResyncRef.current?.().catch(() => {});
      }
    });
    return () => sub.remove();
  }, [token]);

  useEffect(() => {
    if (token && screen === 'home') {
      fetchWallet();
    }
  }, [token, screen, fetchWallet]);

  const handleLogin = async () => {
    if (!emailInput.trim() || !passwordInput) {
      Alert.alert('오류', '이메일과 비밀번호를 입력해주세요.');
      return;
    }
    setAuthLoading(true);
    try {
      const { res, data } = await fetchJson(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: emailInput.trim(),
          password: passwordInput,
        }),
      });
      if (!res.ok) {
        throw new Error(data.message || '로그인 실패');
      }
      await persistSession(data.token, data.email);
      setWalletCount(data.balance);
      setPasswordInput('');
      setScreen('home');
    } catch (err: any) {
      Alert.alert('로그인 실패', err.message || '다시 시도해주세요.');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleRegister = async () => {
    if (!emailInput.trim() || !passwordInput) {
      Alert.alert('오류', '이메일과 비밀번호를 입력해주세요.');
      return;
    }
    if (passwordInput.length < 6) {
      Alert.alert('오류', '비밀번호는 6자 이상이어야 합니다.');
      return;
    }
    setAuthLoading(true);
    try {
      const { res, data } = await fetchJson(`${BASE_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: emailInput.trim(),
          password: passwordInput,
        }),
      });
      if (!res.ok) {
        throw new Error(data.message || '회원가입 실패');
      }
      await persistSession(data.token, data.email);
      setWalletCount(data.balance);
      setPasswordInput('');
      setScreen('home');
      Alert.alert('가입 완료', `${data.email} 계정이 생성되었습니다.`);
    } catch (err: any) {
      Alert.alert('회원가입 실패', err.message || '다시 시도해주세요.');
    } finally {
      setAuthLoading(false);
    }
  };

  const handlePurchase = async () => {
    if (!token || purchaseLoading) return;
    const amt = parseInt(purchaseAmount, 10);
    if (isNaN(amt) || amt <= 0) {
      Alert.alert('오류', '유효한 금액을 입력해주세요');
      return;
    }
    setPurchaseLoading(true);
    try {
      const { res, data } = await fetchJson(`${BASE_URL}/wallet/purchase`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ amount: amt }),
      });
      if (!res.ok) {
        throw new Error(data.message || `Status ${res.status}`);
      }
      setWalletCount(data.balance);
      Alert.alert('구매 완료', `${amt}개 구매 완료. 잔액: ${data.balance}`);
      setPurchaseAmount('0');
      setScreen('home');
    } catch (err: any) {
      Alert.alert(
        '오류',
        err.message || '구매 중 문제가 발생했습니다. 다시 시도해주세요.',
      );
    } finally {
      setPurchaseLoading(false);
    }
  };

  const stopPushPolling = () => {
    if (pushPollTimerRef.current) {
      clearInterval(pushPollTimerRef.current);
      pushPollTimerRef.current = null;
    }
  };

  const markSendFinished = useCallback((sent: number, balance: number) => {
    sendFinishedRef.current = true;
    activeInviteTokenRef.current = null;
    setWalletCount(balance);
    setPushReadComplete(false);
    setIsPushing(false);
    setPushComplete(true);
    setNfcStatus(`전송 완료: ${sent}개`);
    stopPushPolling();
    stopNfcPush(hceSessionRef.current).finally(() => {
      hceSessionRef.current = null;
    });
  }, []);

  const finishSendScreen = async () => {
    stopPushPolling();
    const inviteTok = activeInviteTokenRef.current;
    const activeToken = tokenRef.current;
    if (inviteTok && activeToken && !sendFinishedRef.current) {
      const refunded = await cancelTransferInvite(activeToken, inviteTok);
      if (refunded !== null) {
        setWalletCount(refunded);
      }
    }
    activeInviteTokenRef.current = null;
    await stopNfcPush(hceSessionRef.current);
    hceSessionRef.current = null;
    sendFinishedRef.current = false;
    setIsPushing(false);
    setPushReadComplete(false);
    setPushComplete(false);
    setPushStarting(false);
    setNfcStatus('');
    setTransferAmount('0');
    fetchWallet();
    nfcSenderModeRef.current = null;
    setScreen('home');
  };

  const handleStartPush = async () => {
    if (!token || !userEmail) return;
    const amt = parseInt(transferAmount, 10);
    if (isNaN(amt) || amt <= 0) {
      Alert.alert('오류', '1 이상의 수량을 입력해주세요.');
      return;
    }
    if (amt > walletCount) {
      Alert.alert('잔액 부족', `보유: ${walletCount}개, 전송 요청: ${amt}개`);
      return;
    }

    const ready = await ensureNfcReady();
    if (!ready) {
      return;
    }

    try {
      setPushStarting(true);
      setNfcStatus('서버 연결 중... (Render 첫 요청은 1~2분 걸릴 수 있음)');
      stopPushPolling();
      sendFinishedRef.current = false;
      balanceBeforePushRef.current = walletCount;
      transferAmountAtPushRef.current = amt;
      setPushComplete(false);
      setPushReadComplete(false);
      await stopNfcPush(hceSessionRef.current);
      hceSessionRef.current = null;

      if (nfcRegisterRef.current) {
        nfcSenderModeRef.current = null;
        await nfcRegisterRef.current(true);
        nfcSenderModeRef.current = true;
      }

      setNfcStatus('전송 초대 생성 중...');
      await warmUpApi();
      const invite = await createTransferInvite(token, amt);
      activeInviteTokenRef.current = invite.inviteToken;
      setWalletCount(invite.senderBalance);
      balanceBeforePushRef.current = invite.senderBalance;
      transferAmountAtPushRef.current = amt;

      const nfcContent = buildInviteNfcContent(
        invite.inviteUrl,
        invite.inviteToken,
      );
      const session = await startNfcPush(nfcContent, () => {
        setPushReadComplete(true);
        setNfcStatus('수신 확인 대기 중... 상대방이 받기를 누르거나 앱을 설치해야 합니다.');
      });
      hceSessionRef.current = session;
      setIsPushing(true);
      setPushStarting(false);
      setNfcStatus(
        `${amt}개 전송 준비 완료. 수신폰 등에 1~2초 유지하세요.`,
      );
    } catch (err: any) {
      setPushStarting(false);
      console.warn('NFC Push 오류', err);
      const inviteTok = activeInviteTokenRef.current;
      if (inviteTok && token) {
        const refunded = await cancelTransferInvite(token, inviteTok);
        if (refunded !== null) {
          setWalletCount(refunded);
        }
        activeInviteTokenRef.current = null;
      }
      Alert.alert('오류', err.message || 'NFC 전송을 시작할 수 없습니다.');
    }
  };

  const handleStopPush = async () => {
    await finishSendScreen();
  };

  useEffect(() => {
    if (!isPushing || pushComplete) {
      stopPushPolling();
      return;
    }

    const activeToken = tokenRef.current;
    if (!activeToken) {
      return;
    }

    const beforeBalance = balanceBeforePushRef.current;
    const sentAmount = transferAmountAtPushRef.current;
    const inviteTok = activeInviteTokenRef.current;

    const checkTransferComplete = async () => {
      try {
        if (inviteTok) {
          const { res, data } = await fetchJson(
            `${BASE_URL}/transfer/invite/${inviteTok}`,
            { headers: authHeaders(activeToken) },
          );
          if (res.ok && data.status === 'claimed') {
            markSendFinished(sentAmount, beforeBalance);
            Alert.alert('전송 완료', `${sentAmount}개를 보냈습니다.`);
          }
          return;
        }

        if (!pushReadComplete) {
          return;
        }

        const { res, data } = await fetchJson(`${BASE_URL}/wallet`, {
          headers: authHeaders(activeToken),
        });
        if (!res.ok) {
          return;
        }
        const balance = Number(data.balance);
        const expectedBalance = beforeBalance - sentAmount;
        const balanceDropped = beforeBalance - balance;
        const transferDone =
          balance === expectedBalance ||
          (sentAmount > 0 && balanceDropped >= sentAmount);
        if (transferDone) {
          markSendFinished(sentAmount, balance);
          Alert.alert('전송 완료', `${sentAmount}개를 보냈습니다.`);
        }
      } catch {
        // 폴링 중 일시 오류는 무지하고 다음 시도
      }
    };

    checkTransferComplete();
    pushPollTimerRef.current = setInterval(checkTransferComplete, 4000);

    return () => {
      stopPushPolling();
    };
  }, [pushReadComplete, isPushing, pushComplete, markSendFinished]);

  const presentIncomingTransfer = useCallback(
    (payload: TransferPayload) => {
      if (receiveLoading) {
        return;
      }
      setIncomingPayload(payload);
    },
    [receiveLoading],
  );

  useEffect(() => {
    presentIncomingTransferRef.current = presentIncomingTransfer;
  }, [presentIncomingTransfer]);

  useEffect(() => {
    if (!token || booting) {
      return;
    }

    const openInviteUrl = async (url: string | null) => {
      if (!url) {
        return;
      }
      const inviteToken = parseInviteTokenFromUri(url);
      if (!inviteToken) {
        return;
      }
      try {
        await warmUpApi();
        const payload = await fetchInviteDetails(inviteToken);
        pendingPayloadRef.current = payload;
        setScreen('receive');
      } catch (err: any) {
        Alert.alert('초대 오류', err.message || '초대를 불러올 수 없습니다.');
      }
    };

    Linking.getInitialURL()
      .then(openInviteUrl)
      .catch(() => {});

    const sub = Linking.addEventListener('url', event => {
      openInviteUrl(event.url);
    });

    return () => sub.remove();
  }, [token, booting]);

  const handleConfirmReceive = async () => {
    const payload = incomingPayload;
    const activeToken = tokenRef.current;
    if (!payload || !activeToken || receiveLoading) {
      return;
    }

    receiveBusyRef.current = true;
    setReceiveLoading(true);
    setNfcStatus('수신 처리 중... Render 서버 연결 중 (최대 2분, 자동 재시도)');
    try {
      const balance = await sendToBackend(activeToken, payload);
      setWalletCount(balance);
      setIncomingPayload(null);
      setNfcStatus(`전송 완료: ${payload.amount}개 수신`);
    } catch (err: any) {
      console.warn('백엔드 전송 오류', err);
      Alert.alert('오류', err.message || '서버 전송 중 문제가 발생했습니다.');
      setNfcStatus('수신 실패. 다시 태그해 주세요.');
    } finally {
      setReceiveLoading(false);
      receiveBusyRef.current = false;
    }
  };

  const handleCancelReceive = () => {
    setIncomingPayload(null);
    if (listeningRef.current) {
      setNfcStatus('수신 대기 중... 송신폰을 가까이 대세요.');
    } else {
      setNfcStatus('');
    }
  };

  const handleStartListen = async () => {
    const ready = await ensureNfcReady();
    if (!ready) {
      return;
    }

    try {
      listeningRef.current = true;
      setIsListening(true);
      setNfcStatus('서버 준비 중...');
      await warmUpApi();
      const pending = pendingPayloadRef.current;
      if (pending) {
        pendingPayloadRef.current = null;
        setIncomingPayload(pending);
      } else {
        setNfcStatus('수신 대기 중... 송신폰을 가까이 대세요.');
      }
    } catch (err) {
      console.warn('NFC Listen 오류', err);
      listeningRef.current = false;
      setIsListening(false);
      Alert.alert('오류', 'NFC 수신을 시작할 수 없습니다.');
    }
  };

  const handleStopListen = async () => {
    listeningRef.current = false;
    receiveBusyRef.current = false;
    pendingPayloadRef.current = null;
    setIncomingPayload(null);
    setReceiveLoading(false);
    setIsListening(false);
    setNfcStatus('');
    setScreen('home');
  };

  useEffect(() => {
    if (!token) return;
    if (screen === 'receive' && !isListening) {
      handleStartListen();
    }
    if (screen !== 'receive' && isListening) {
      handleStopListen();
    }
    if (screen !== 'send' && (isPushing || pushComplete)) {
      stopPushPolling();
      stopNfcPush(hceSessionRef.current);
      hceSessionRef.current = null;
      sendFinishedRef.current = false;
      setIsPushing(false);
      setPushReadComplete(false);
      setPushComplete(false);
      setNfcStatus('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, token]);

  if (booting) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#333333" />
        </View>
      </SafeAreaView>
    );
  }

  const renderDoneScreen = (
    title: string,
    message: string,
    onHome: () => void,
  ) => (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={styles.doneScrollContent}
      keyboardShouldPersistTaps="handled">
      <View style={styles.doneCard}>
        <Text style={styles.doneTitle}>{title}</Text>
        <Text style={styles.doneMessage}>{message}</Text>
        <Pressable style={styles.primaryButton} onPress={onHome}>
          <Text style={styles.primaryButtonText}>홈으로</Text>
        </Pressable>
      </View>
    </ScrollView>
  );

  const renderLogin = () => (
    <View style={styles.section}>
      <Text style={styles.title}>Treasure Transfer</Text>
      <Text style={styles.subtitle}>로그인</Text>
      <Text style={styles.hint}>
        첫 요청은 Render 서버 시작으로 1~2분 걸릴 수 있습니다.
      </Text>
      <TextInput
        style={styles.input}
        placeholder="이메일"
        autoCapitalize="none"
        keyboardType="email-address"
        value={emailInput}
        onChangeText={setEmailInput}
      />
      <TextInput
        style={styles.input}
        placeholder="비밀번호"
        secureTextEntry
        value={passwordInput}
        onChangeText={setPasswordInput}
      />
      <Button
        title={authLoading ? '서버 응답 대기 중...' : '로그인'}
        onPress={handleLogin}
        disabled={authLoading}
      />
      {authLoading ? (
        <Text style={styles.hint}>최대 2분까지 기다려주세요.</Text>
      ) : null}
      <View style={styles.spacer} />
      <Button
        title="회원가입"
        onPress={() => {
          setPasswordInput('');
          setScreen('register');
        }}
      />
    </View>
  );

  const renderRegister = () => (
    <View style={styles.section}>
      <Text style={styles.title}>회원가입</Text>
      <TextInput
        style={styles.input}
        placeholder="이메일"
        autoCapitalize="none"
        keyboardType="email-address"
        value={emailInput}
        onChangeText={setEmailInput}
      />
      <TextInput
        style={styles.input}
        placeholder="비밀번호 (6자 이상)"
        secureTextEntry
        value={passwordInput}
        onChangeText={setPasswordInput}
      />
      <Button
        title={authLoading ? '서버 응답 대기 중...' : '가입하기'}
        onPress={handleRegister}
        disabled={authLoading}
      />
      <View style={styles.spacer} />
      <Button title="로그인으로" onPress={() => setScreen('login')} />
    </View>
  );

  const renderHome = () => (
    <View style={styles.menuContainer}>
      <Text style={styles.title}>Treasure Transfer</Text>
      <Text style={styles.subtitle}>{userEmail}</Text>
      <Button title="보물 구매" onPress={() => setScreen('purchase')} />
      <View style={styles.spacer} />
      <Button title="보내기 (Push)" onPress={() => setScreen('send')} />
      <View style={styles.spacer} />
      <Button
        title="받기 (미리 대기)"
        onPress={() => setScreen('receive')}
      />
      <Text style={styles.hint}>
        보내는 쪽이 전송을 시작한 뒤, 등을 맞추고 1~2초 유지하면 받을 수
        있습니다. 앱이 없는 폰은 설치 페이지가 열립니다.
      </Text>
      {nfcTapHint ? <Text style={styles.nfcTapHint}>{nfcTapHint}</Text> : null}
      <View style={styles.balance}>
        <Text style={styles.balanceText}>지갑 잔액: {walletCount}개</Text>
        <View style={styles.spacer} />
        <Button
          title={walletLoading ? '잔액 불러오는 중...' : '잔액 새로고침'}
          onPress={() => fetchWallet(true)}
          disabled={walletLoading}
        />
        <View style={styles.spacer} />
        <Button title="로그아웃" onPress={clearSession} color="#666" />
      </View>
    </View>
  );

  const renderPurchase = () => (
    <View style={styles.section}>
      <Text style={styles.label}>구매할 보물 수:</Text>
      <TextInput
        style={styles.input}
        keyboardType="number-pad"
        value={purchaseAmount}
        onChangeText={setPurchaseAmount}
        editable={!purchaseLoading}
      />
      <Button
        title={purchaseLoading ? '구매 처리 중...' : '구매하기'}
        onPress={handlePurchase}
        disabled={purchaseLoading}
      />
      {purchaseLoading ? (
        <Text style={styles.hint}>서버 응답을 기다리는 중입니다. 다시 누르지 마세요.</Text>
      ) : null}
      <View style={styles.spacer} />
      <Button
        title="뒤로"
        onPress={() => setScreen('home')}
        disabled={purchaseLoading}
      />
    </View>
  );

  const renderSend = () => {
    const sendDone =
      pushComplete ||
      sendFinishedRef.current ||
      isSendFinishedStatus(nfcStatus);
    const showSendHome = sendDone || pushReadComplete;

    if (sendDone) {
      return renderDoneScreen('전송 완료', nfcStatus, finishSendScreen);
    }

    return (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={styles.formScrollContent}
      keyboardShouldPersistTaps="handled">
    <View style={styles.formBody}>
      <Text style={styles.label}>전송할 보물 수:</Text>
      <TextInput
        style={styles.input}
        keyboardType="number-pad"
        value={transferAmount}
        onChangeText={setTransferAmount}
        editable={!isPushing && !pushStarting}
      />
      {!isPushing && !pushStarting ? (
        <>
          <Button
            title={pushStarting ? '준비 중...' : '전송 시작 (Push)'}
            onPress={handleStartPush}
            disabled={pushStarting}
          />
          <Text style={styles.hint}>
            전송 시작 후 등을 맞추세요. 상대 앱이 없으면 브라우저에 설치
            링크가 열립니다.
          </Text>
        </>
      ) : (
        <>
          <View style={styles.statusRow}>
            {(pushStarting || (!showSendHome && isPushing)) ? (
              <ActivityIndicator size="small" color="#333" />
            ) : null}
          </View>
          <Text style={styles.sendStatusText}>
            {nfcStatus ||
              (pushStarting
                ? '서버에 연결 중입니다...'
                : '수신폰을 등에 대고 1~2초 유지해 주세요.')}
          </Text>
          <View style={styles.spacer} />
          {showSendHome ? (
            <Pressable style={styles.primaryButton} onPress={handleStopPush}>
              <Text style={styles.primaryButtonText}>홈으로</Text>
            </Pressable>
          ) : (
            <Button
              title="전송 중지"
              onPress={handleStopPush}
              color="#c00"
            />
          )}
        </>
      )}
      <View style={styles.spacer} />
      <Button
        title="뒤로"
        onPress={() => setScreen('home')}
        disabled={isPushing || pushStarting}
      />
    </View>
    </ScrollView>
  );
  };

  const renderReceive = () => {
    const receiveDone = isSendFinishedStatus(nfcStatus);

    if (receiveDone) {
      return renderDoneScreen('수신 완료', nfcStatus, () => {
        setNfcStatus('');
        setScreen('home');
      });
    }

    if (incomingPayload) {
      return (
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.formScrollContent}
          keyboardShouldPersistTaps="handled">
        <View style={styles.formBody}>
          <Text style={styles.label}>보물 수신</Text>
          <Text style={styles.receiveFrom}>{incomingPayload.fromEmail}</Text>
          <Text style={styles.receiveAmount}>{incomingPayload.amount}개</Text>
          <Text style={styles.hint}>아래 버튼을 눌러 받으세요.</Text>
          <View style={styles.spacer} />
          {receiveLoading ? (
            <>
              <ActivityIndicator size="large" color="#333333" />
              <Text style={styles.statusText}>{nfcStatus}</Text>
            </>
          ) : (
            <>
              <Pressable
                style={styles.primaryButton}
                onPress={handleConfirmReceive}>
                <Text style={styles.primaryButtonText}>
                  {incomingPayload.amount}개 받기
                </Text>
              </Pressable>
              <View style={styles.spacer} />
              <Button title="취소" onPress={handleCancelReceive} color="#666" />
            </>
          )}
        </View>
        </ScrollView>
      );
    }

    return (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={styles.formScrollContent}
      keyboardShouldPersistTaps="handled">
    <View style={styles.formBody}>
      <Text style={styles.label}>보물 수신 대기</Text>
      <View style={styles.statusRow}>
        {isListening ? (
          <ActivityIndicator size="small" color="#333" />
        ) : null}
        <Text style={styles.statusText}>
          {nfcStatus || '수신 준비 중...'}
        </Text>
      </View>
      <Text style={styles.hint}>
        송신폰을 등쪽으로 맞춘 뒤 1~2초 유지해 주세요.
      </Text>
      <View style={styles.spacer} />
      <Button
        title="수신 중지"
        onPress={handleStopListen}
        color="#c00"
        disabled={receiveLoading}
      />
      <View style={styles.spacer} />
      <Button
        title="뒤로"
        onPress={() => setScreen('home')}
        disabled={receiveLoading}
      />
    </View>
    </ScrollView>
  );
  };

  return (
    <SafeAreaView style={styles.container}>
      {screen === 'login' && renderLogin()}
      {screen === 'register' && renderRegister()}
      {screen === 'home' && renderHome()}
      {screen === 'purchase' && renderPurchase()}
      {screen === 'send' && renderSend()}
      {screen === 'receive' && renderReceive()}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ffffff' },
  flex: { flex: 1 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  menuContainer: {
    flex: 1,
    justifyContent: 'center',
    padding: 16,
    paddingBottom: BOTTOM_NAV_PADDING,
  },
  section: {
    flex: 1,
    justifyContent: 'center',
    padding: 16,
    paddingBottom: BOTTOM_NAV_PADDING,
  },
  formScrollContent: {
    flexGrow: 1,
    paddingHorizontal: 16,
    paddingTop: 24,
    paddingBottom: BOTTOM_NAV_PADDING,
  },
  formBody: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  doneScrollContent: {
    flexGrow: 1,
    paddingHorizontal: 16,
    paddingTop: 48,
    paddingBottom: BOTTOM_NAV_PADDING,
    justifyContent: 'center',
  },
  doneCard: {
    alignItems: 'center',
    paddingVertical: 24,
  },
  doneTitle: {
    fontSize: 26,
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: 12,
    color: '#111111',
  },
  doneMessage: {
    fontSize: 16,
    color: '#333333',
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 32,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: 8,
    color: '#111111',
  },
  subtitle: {
    fontSize: 14,
    textAlign: 'center',
    color: '#666',
    marginBottom: 8,
  },
  hint: {
    fontSize: 12,
    textAlign: 'center',
    color: '#888',
    marginBottom: 16,
  },
  nfcTapHint: {
    fontSize: 13,
    textAlign: 'center',
    color: '#c60',
    marginBottom: 12,
    paddingHorizontal: 8,
  },
  label: { fontSize: 18, marginBottom: 8, color: '#111111' },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    padding: 8,
    marginBottom: 16,
    borderRadius: 4,
    color: '#111111',
    backgroundColor: '#ffffff',
  },
  spacer: { height: 16 },
  balance: { marginTop: 32, alignItems: 'center' },
  balanceText: { fontSize: 20, fontWeight: 'bold', color: '#111111' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusText: { fontSize: 14, flex: 1, color: '#333', textAlign: 'center' },
  sendStatusText: {
    fontSize: 16,
    color: '#111',
    textAlign: 'center',
    marginVertical: 12,
    paddingHorizontal: 8,
    lineHeight: 22,
  },
  receiveFrom: {
    fontSize: 16,
    textAlign: 'center',
    color: '#666',
    marginBottom: 8,
  },
  receiveAmount: {
    fontSize: 36,
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: 8,
    color: '#111111',
  },
  primaryButton: {
    backgroundColor: '#0066cc',
    paddingVertical: 18,
    paddingHorizontal: 32,
    borderRadius: 12,
    alignItems: 'center',
    alignSelf: 'stretch',
    maxWidth: 320,
  },
  primaryButtonText: {
    color: '#ffffff',
    fontSize: 20,
    fontWeight: 'bold',
  },
});
