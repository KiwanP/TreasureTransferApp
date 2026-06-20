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
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NfcManager, { Ndef, NfcEvents } from 'react-native-nfc-manager';
import {
  HCESession,
  NFCTagType4,
  NFCTagType4NDEFContentType,
} from 'react-native-hce';
import { API_BASE } from '@env';

const BASE_URL = API_BASE || 'http://localhost:5000/api';
const TOKEN_KEY = '@treasure_token';
const EMAIL_KEY = '@treasure_email';

type TransferPayload = { type: 'TRANSFER'; amount: number; fromEmail: string };
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

async function sendToBackend(
  token: string,
  payload: TransferPayload,
): Promise<number> {
  const res = await fetch(`${BASE_URL}/wallet/receive`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      amount: payload.amount,
      fromEmail: payload.fromEmail,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Status ${res.status}`);
  }
  const data = await res.json();
  return data.balance;
}

function parseNdefPayload(tag: any): TransferPayload | null {
  if (!tag?.ndefMessage?.length) {
    return null;
  }
  const text = Ndef.text.decodePayload(tag.ndefMessage[0].payload);
  const payload = JSON.parse(text);
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

async function startNfcPush(
  payload: TransferPayload,
  onRead?: () => void,
): Promise<HCESession> {
  const tag = new NFCTagType4({
    type: NFCTagType4NDEFContentType.Text,
    content: JSON.stringify(payload),
    writable: false,
  });

  const session = await HCESession.getInstance();
  await session.setApplication(tag);
  await session.setEnabled(true);

  if (onRead) {
    session.on(HCESession.Events.HCE_STATE_READ, onRead);
  }

  return session;
}

async function stopNfcPush(session: HCESession | null): Promise<void> {
  if (!session) {
    return;
  }
  try {
    await session.setEnabled(false);
  } catch (err) {
    console.warn('HCE 세션 종료 오류', err);
  }
}

async function startNfcListen(
  onData: (data: TransferPayload) => void,
): Promise<void> {
  NfcManager.setEventListener(NfcEvents.DiscoverTag, (tag: any) => {
    try {
      const payload = parseNdefPayload(tag);
      if (payload) {
        onData(payload);
      }
    } catch (err) {
      console.warn('수신 데이터 파싱 오류', err);
    }
  });

  await NfcManager.registerTagEvent();
}

async function stopNfcListen(): Promise<void> {
  try {
    NfcManager.setEventListener(NfcEvents.DiscoverTag, null);
    await NfcManager.unregisterTagEvent();
  } catch (err) {
    console.warn('NFC 리스닝 종료 오류', err);
  }
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
  const [isListening, setIsListening] = useState(false);
  const [nfcStatus, setNfcStatus] = useState<string>('');
  const [authLoading, setAuthLoading] = useState(false);

  const hceSessionRef = useRef<HCESession | null>(null);
  const listeningRef = useRef(false);
  const tokenRef = useRef<string | null>(null);

  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  const persistSession = async (newToken: string, email: string) => {
    await AsyncStorage.multiSet([
      [TOKEN_KEY, newToken],
      [EMAIL_KEY, email],
    ]);
    setToken(newToken);
    setUserEmail(email);
  };

  const clearSession = async () => {
    await AsyncStorage.multiRemove([TOKEN_KEY, EMAIL_KEY]);
    setToken(null);
    setUserEmail('');
    setWalletCount(0);
    setScreen('login');
  };

  const fetchWallet = useCallback(
    (showResult = false) => {
      const activeToken = tokenRef.current;
      if (!activeToken) {
        return;
      }
      fetch(`${BASE_URL}/wallet`, { headers: authHeaders(activeToken) })
        .then(res => {
          if (res.status === 401 || res.status === 403) {
            clearSession();
            throw new Error('Session expired');
          }
          if (!res.ok) throw new Error(`Status ${res.status}`);
          return res.json();
        })
        .then(data => {
          setWalletCount(data.balance);
          setUserEmail(data.email);
          if (showResult) {
            Alert.alert('잔액 갱신', `서버 잔액: ${data.balance}개`);
          }
        })
        .catch((err: any) => {
          console.warn('지갑 조회 실패', err);
          if (showResult && tokenRef.current) {
            Alert.alert(
              '서버 연결 실패',
              'API 주소와 네트워크 연결을 확인해주세요.',
            );
          }
        });
    },
    [],
  );

  useEffect(() => {
    NfcManager.start()
      .then(() => console.log('NFC Manager started'))
      .catch((err: any) => console.warn('NFC 초기화 실패', err));

    AsyncStorage.multiGet([TOKEN_KEY, EMAIL_KEY])
      .then(([[, savedToken], [, savedEmail]]) => {
        if (savedToken && savedEmail) {
          setToken(savedToken);
          setUserEmail(savedEmail);
          tokenRef.current = savedToken;
          setScreen('home');
        }
      })
      .finally(() => setBooting(false));

    return () => {
      stopNfcPush(hceSessionRef.current);
      stopNfcListen();
    };
  }, []);

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
      const res = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: emailInput.trim(),
          password: passwordInput,
        }),
      });
      const data = await res.json();
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
      const res = await fetch(`${BASE_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: emailInput.trim(),
          password: passwordInput,
        }),
      });
      const data = await res.json();
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

  const handlePurchase = () => {
    if (!token) return;
    const amt = parseInt(purchaseAmount, 10);
    if (isNaN(amt) || amt <= 0) {
      Alert.alert('오류', '유효한 금액을 입력해주세요');
      return;
    }
    fetch(`${BASE_URL}/wallet/purchase`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ amount: amt }),
    })
      .then(res => {
        if (!res.ok) throw new Error(`Status ${res.status}`);
        return res.json();
      })
      .then(data => {
        setWalletCount(data.balance);
        Alert.alert('구매 완료', `${amt}개 구매 완료. 잔액: ${data.balance}`);
        setPurchaseAmount('0');
        setScreen('home');
      })
      .catch(() => {
        Alert.alert('오류', '구매 중 문제가 발생했습니다. 다시 시도해주세요.');
      });
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
      await stopNfcPush(hceSessionRef.current);
      const payload: TransferPayload = {
        type: 'TRANSFER',
        amount: amt,
        fromEmail: userEmail,
      };
      const session = await startNfcPush(payload, () => {
        setNfcStatus('상대 기기가 데이터를 읽었습니다. 수신 확인을 기다리세요.');
      });
      hceSessionRef.current = session;
      setIsPushing(true);
      setNfcStatus(`${amt}개 전송 준비 완료. 수신폰에 기기를 가까이 대세요.`);
      Alert.alert(
        '전송 준비',
        `${amt}개 전송 준비 완료. 수신폰에 기기를 가까이 대세요.`,
      );
    } catch (err) {
      console.warn('NFC Push 오류', err);
      Alert.alert('오류', 'NFC 전송을 시작할 수 없습니다.');
    }
  };

  const handleStopPush = async () => {
    await stopNfcPush(hceSessionRef.current);
    hceSessionRef.current = null;
    setIsPushing(false);
    setNfcStatus('');
    setTransferAmount('0');
    fetchWallet();
    setScreen('home');
  };

  const handleIncomingTransfer = useCallback((payload: TransferPayload) => {
    if (!listeningRef.current) {
      return;
    }

    const activeToken = tokenRef.current;
    if (!activeToken) {
      Alert.alert('오류', '로그인이 필요합니다.');
      return;
    }

    Alert.alert(
      '전송 요청',
      `${payload.fromEmail}님이 ${payload.amount}개를 보냅니다.\n받으시겠습니까?`,
      [
        { text: '아니오', style: 'cancel' },
        {
          text: '예',
          onPress: () => {
            sendToBackend(activeToken, payload)
              .then(balance => {
                setWalletCount(balance);
                setNfcStatus(`전송 완료: ${payload.amount}개 수신`);
                Alert.alert(
                  '전송 완료',
                  `${payload.fromEmail}님으로부터 ${payload.amount}개를 받았습니다.`,
                );
              })
              .catch((err: any) => {
                console.warn('백엔드 전송 오류', err);
                Alert.alert(
                  '오류',
                  err.message || '서버 전송 중 문제가 발생했습니다.',
                );
              });
          },
        },
      ],
    );
  }, []);

  const handleStartListen = async () => {
    const ready = await ensureNfcReady();
    if (!ready) {
      return;
    }

    try {
      await stopNfcListen();
      listeningRef.current = true;
      await startNfcListen(handleIncomingTransfer);
      setIsListening(true);
      setNfcStatus('수신 대기 중... 송신폰을 가까이 대세요.');
    } catch (err) {
      console.warn('NFC Listen 오류', err);
      Alert.alert('오류', 'NFC 수신을 시작할 수 없습니다.');
    }
  };

  const handleStopListen = async () => {
    listeningRef.current = false;
    await stopNfcListen();
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
    if (screen !== 'send' && isPushing) {
      stopNfcPush(hceSessionRef.current);
      hceSessionRef.current = null;
      setIsPushing(false);
      setNfcStatus('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, token]);

  if (booting) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" />
        </View>
      </SafeAreaView>
    );
  }

  const renderLogin = () => (
    <View style={styles.section}>
      <Text style={styles.title}>Treasure Transfer</Text>
      <Text style={styles.subtitle}>로그인</Text>
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
        title={authLoading ? '처리 중...' : '로그인'}
        onPress={handleLogin}
        disabled={authLoading}
      />
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
        title={authLoading ? '처리 중...' : '가입하기'}
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
      <Button title="받기 (Listen)" onPress={() => setScreen('receive')} />
      <View style={styles.balance}>
        <Text style={styles.balanceText}>지갑 잔액: {walletCount}개</Text>
        <View style={styles.spacer} />
        <Button title="잔액 새로고침" onPress={() => fetchWallet(true)} />
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
      />
      <Button title="구매하기" onPress={handlePurchase} />
      <View style={styles.spacer} />
      <Button title="뒤로" onPress={() => setScreen('home')} />
    </View>
  );

  const renderSend = () => (
    <View style={styles.section}>
      <Text style={styles.label}>전송할 보물 수:</Text>
      <TextInput
        style={styles.input}
        keyboardType="number-pad"
        value={transferAmount}
        onChangeText={setTransferAmount}
        editable={!isPushing}
      />
      {!isPushing ? (
        <Button title="전송 시작 (Push)" onPress={handleStartPush} />
      ) : (
        <>
          <View style={styles.statusRow}>
            <ActivityIndicator size="small" color="#333" />
            <Text style={styles.statusText}>{nfcStatus}</Text>
          </View>
          <View style={styles.spacer} />
          <Button title="전송 중지" onPress={handleStopPush} color="#c00" />
        </>
      )}
      <View style={styles.spacer} />
      <Button
        title="뒤로"
        onPress={() => setScreen('home')}
        disabled={isPushing}
      />
    </View>
  );

  const renderReceive = () => (
    <View style={styles.section}>
      <Text style={styles.label}>보물 수신 대기</Text>
      <View style={styles.statusRow}>
        <ActivityIndicator size="small" color="#333" />
        <Text style={styles.statusText}>
          {nfcStatus || '수신 준비 중...'}
        </Text>
      </View>
      <View style={styles.spacer} />
      <Button title="수신 중지" onPress={handleStopListen} color="#c00" />
      <View style={styles.spacer} />
      <Button title="뒤로" onPress={() => setScreen('home')} />
    </View>
  );

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
  container: { flex: 1 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  menuContainer: { flex: 1, justifyContent: 'center', padding: 16 },
  section: { flex: 1, justifyContent: 'center', padding: 16 },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    textAlign: 'center',
    color: '#666',
    marginBottom: 24,
  },
  label: { fontSize: 18, marginBottom: 8 },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    padding: 8,
    marginBottom: 16,
    borderRadius: 4,
  },
  spacer: { height: 16 },
  balance: { marginTop: 32, alignItems: 'center' },
  balanceText: { fontSize: 20, fontWeight: 'bold' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusText: { fontSize: 14, flex: 1, color: '#333' },
});
