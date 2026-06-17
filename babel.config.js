module.exports = {
  presets: [
    //'module:metro-react-native-babel-preset',
    '@react-native/babel-preset',          // ← RN 공식 프리셋 (TS + Flow 모두 지원)
  ],
  plugins: [
    //'babel-plugin-syntax-hermes-parser',  // ← Hermes/Flow 문법 파싱
    //'@babel/plugin-transform-flow-strip-types', // Flow 타입 제거
    ['module:react-native-dotenv', {       // 기존 dotenv 플러그인
      moduleName: '@env',
      path: '.env',
      safe: false,
      allowUndefined: true,
    }],
  ],
};
