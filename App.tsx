// App.tsx
// @ts-nocheck
import React, { useEffect, useState } from 'react';
import {
  SafeAreaView,
  StyleSheet,
  View,
  Text,
  TextInput,
  Button,
  Alert,
} from 'react-native';
import NfcManager, { Ndef } from 'react-native-nfc-manager';
import { API_BASE } from '@env';  // .env에 설정된 백엔드 API 주소

// 환경변수가 없으면 로컬 터널링 주소로 대체
const BASE_URL = API_BASE || 'http://localhost:5000/api';

type Screen = 'home' | 'purchase' | 'transfer';

export default function App() {
  // NFC 매니저 초기화
  useEffect(() => {
    NfcManager.start()
      .then(() => console.log('NFC Manager started'))
      .catch((err: any) => console.warn('NFC 초기화 실패', err));
  }, []);

  const [screen, setScreen] = useState<Screen>('home');
  const [walletCount, setWalletCount] = useState<number>(0);
  const [purchaseAmount, setPurchaseAmount] = useState<string>('0');
  const [transferAmount, setTransferAmount] = useState<string>('0');

  // 서버에서 지갑 잔액 불러오기
  useEffect(() => {
    console.log('Using BASE_URL for wallet:', BASE_URL);
    fetch(`${BASE_URL}/wallet`, { credentials: 'include' })
      .then(res => {
        console.log('Wallet fetch status:', res.status);
        return res.json();
      })
      .then(data => setWalletCount(data.balance))
      .catch((err: any) => console.warn('지갑 조회 실패', err));
  }, []);

  // 구매 처리
  const handlePurchase = () => {
    const amt = parseInt(purchaseAmount, 10);
    if (isNaN(amt) || amt <= 0) {
      Alert.alert('오류', '유효한 금액을 입력해주세요');
      return;
    }
    const url = `${BASE_URL}/wallet/purchase`;
    console.log('Purchasing at:', url, amt);
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ amount: amt }),
    })
      .then(res => {
        console.log('Purchase status:', res.status);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        return res.json();
      })
      .then(data => {
        setWalletCount(data.balance);
        Alert.alert('구매 완료', `${amt}개 구매 완료. 잔액: ${data.balance}`);
        setPurchaseAmount('0');
        setScreen('home');
      })
      .catch(err => {
        console.warn('구매 API 오류', err);
        Alert.alert('오류', '구매 중 문제가 발생했습니다. 다시 시도해주세요.');
      });
  };

  // 전송 처리
  const handleTransfer = () => {
    const amt = parseInt(transferAmount, 10);
    if (isNaN(amt) || amt <= 0 || amt > walletCount) {
      Alert.alert('오류', '전송할 수량이 올바르지 않습니다.');
      return;
    }
    const message = Ndef.encodeMessage([
      Ndef.textRecord(JSON.stringify({ type: 'TRANSFER', amount: amt })),
    ]);
    NfcManager.setNdefPushMessage(message)
      .then(() => console.log('NDEF push 설정 완료'))
      .catch((err: any) => console.warn('NDEF push 오류', err));

    NfcManager.registerTagEvent({
      onTagDiscovered: (tag: any) => {
        try {
          const text = Ndef.text.decodePayload(tag.ndefMessage[0].payload);
          const payload = JSON.parse(text);
          if (payload.type === 'TRANSFER') {
            Alert.alert(
              '전송 요청',
              `${payload.amount}개를 받으시겠습니까?`,
              [
                { text: '아니오', style: 'cancel' },
                {
                  text: '예',
                  onPress: () => {
                    fetch(`${BASE_URL}/wallet/transfer`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      credentials: 'include',
                      body: JSON.stringify({ amount: payload.amount }),
                    })
                      .then(res => res.json())
                      .then(data => {
                        setWalletCount(data.balance);
                        Alert.alert('전송 완료', `${payload.amount}개를 받았습니다.`);
                      })
                      .catch((err: any) => console.warn('전송 API 오류', err));
                    NfcManager.unregisterTagEvent().catch(() => {});
                  },
                },
              ],
            );
          }
        } catch (e) {
          console.warn('수신 데이터 파싱 오류', e);
        }
      },
    })
      .then(() => console.log('NFC 이벤트 리스닝 시작'))
      .catch((err: any) => console.warn('리스닝 등록 실패', err));

    Alert.alert('전송 준비', `${amt}개 전송 준비 완료. 휴대폰을 가까이 대세요.`);
    setTransferAmount('0');
    setScreen('home');
  };

  const renderHome = () => (
    <View style={styles.menuContainer}>
      <Button title="보물 구매" onPress={() => setScreen('purchase')} />
      <View style={styles.spacer} />
      <Button title="보물 전송" onPress={() => setScreen('transfer')} />
      <View style={styles.balance}>
        <Text style={styles.balanceText}>지갑 잔액: {walletCount}개</Text>
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

  const renderTransfer = () => (
    <View style={styles.section}>
      <Text style={styles.label}>전송할 보물 수:</Text>
      <TextInput
        style={styles.input}
        keyboardType="number-pad"
        value={transferAmount}
        onChangeText={setTransferAmount}
      />
      <Button title="전송 준비" onPress={handleTransfer} />
      <View style={styles.spacer} />
      <Button title="뒤로" onPress={() => setScreen('home')} />
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      {screen === 'home' && renderHome()}
      {screen === 'purchase' && renderPurchase()}
      {screen === 'transfer' && renderTransfer()}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  menuContainer: { flex: 1, justifyContent: 'center', padding: 16 },
  section: { flex: 1, justifyContent: 'center', padding: 16 },
  label: { fontSize: 18, marginBottom: 8 },
  input: { borderWidth: 1, borderColor: '#ccc', padding: 8, marginBottom: 16, borderRadius: 4 },
  spacer: { height: 16 },
  balance: { marginTop: 32, alignItems: 'center' },
  balanceText: { fontSize: 20, fontWeight: 'bold' },
});
