import React, { useEffect, useRef, useState, useCallback } from 'react';
import { ChevronUp, ChevronDown, RotateCcw } from 'lucide-react';

export default function App() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  // Estados
  const [faceDetected, setFaceDetected] = useState(false);
  const [currentRatio, setCurrentRatio] = useState(0.40);
  const [neutralPoint, setNeutralPoint] = useState(null);
  const [activeZone, setActiveZone] = useState(null); // 'UP' | 'DOWN' | null
  const [progress, setProgress] = useState(0);
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [statusMsg, setStatusMsg] = useState('Esperando rostro...');

  // Sensibilidad (umbral de desviación respecto al neutro)
  const [sensitivity, setSensitivity] = useState(0.035); 
  const dwellTime = 1000; // 1 segundo sostenido para confirmar

  // Referencias para bucle y temporizador
  const neutralPointRef = useRef(null);
  const activeZoneRef = useRef(null);
  const dwellStartRef = useRef(null);
  const lastTriggerRef = useRef(0);
  const historyRef = useRef([]);

  // Síntesis de voz en español
  const speak = useCallback((text) => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'es-ES';
      utterance.rate = 0.95;
      window.speechSynthesis.speak(utterance);
    }
  }, []);

  // Cálculo binocular promediado
  const calculateRatio = (landmarks) => {
    // Ojo Izquierdo: párpados 159 (arriba) y 145 (abajo), iris 468
    const topL = landmarks[159].y;
    const botL = landmarks[145].y;
    const irisL = landmarks[468].y;
    const hL = botL - topL;

    // Ojo Derecho: párpados 386 (arriba) y 374 (abajo), iris 473
    const topR = landmarks[386].y;
    const botR = landmarks[374].y;
    const irisR = landmarks[473].y;
    const hR = botR - topR;

    // Ignorar si parpadea o cierra los ojos
    if (hL < 0.007 || hR < 0.007) return null;

    const rL = (irisL - topL) / hL;
    const rR = (irisR - topR) / hR;
    return (rL + rR) / 2;
  };

  const evaluateGaze = useCallback((rawRatio) => {
    // Suavizado móvil (últimas 5 lecturas) para estabilizar la señal
    historyRef.current.push(rawRatio);
    if (historyRef.current.length > 5) historyRef.current.shift();
    const ratio = historyRef.current.reduce((a, b) => a + b, 0) / historyRef.current.length;
    
    setCurrentRatio(parseFloat(ratio.toFixed(3)));

    const neutral = neutralPointRef.current;
    if (neutral === null) return;

    const now = performance.now();

    // Pausa protectora de 2 segundos tras hablar
    if (now - lastTriggerRef.current < 2000) {
      resetSelection();
      return;
    }

    let detected = null;

    // REGLA FÍSICA REAL:
    // Al mirar ARRIBA: el iris sube acercándose al párpado superior -> ratio disminuye
    if (ratio < neutral - sensitivity) {
      detected = 'UP';
    } 
    // Al mirar ABAJO: el iris baja alejándose del párpado superior -> ratio aumenta
    else if (ratio > neutral + sensitivity) {
      detected = 'DOWN';
    } 
    // ZONA DE DESCANSO (CENTRO)
    else {
      detected = null;
    }

    if (detected && detected === activeZoneRef.current) {
      const elapsed = now - dwellStartRef.current;
      const pct = Math.min((elapsed / dwellTime) * 100, 100);
      setProgress(pct);

      if (elapsed >= dwellTime) {
        if (detected === 'UP') speak('Sí');
        if (detected === 'DOWN') speak('No');

        lastTriggerRef.current = now;
        resetSelection();
      }
    } else if (detected) {
      activeZoneRef.current = detected;
      dwellStartRef.current = now;
      setActiveZone(detected);
    } else {
      resetSelection();
    }
  }, [sensitivity, dwellTime, speak]);

  const resetSelection = () => {
    activeZoneRef.current = null;
    dwellStartRef.current = null;
    setActiveZone(null);
    setProgress(0);
  };

  useEffect(() => {
    const FaceMeshClass = window.FaceMesh;
    const CameraClass = window.Camera;
    if (!FaceMeshClass || !CameraClass) return;

    const faceMesh = new FaceMeshClass({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
    });

    faceMesh.setOptions({
      maxNumFaces: 1,
      refineLandmarks: true,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5
    });

    faceMesh.onResults((results) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      ctx.save();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(results.image, 0, 0, canvas.width, canvas.height);

      if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
        setFaceDetected(true);
        const lm = results.multiFaceLandmarks[0];

        // Dibujar los puntos del iris en celeste
        [468, 473].forEach((idx) => {
          const pt = lm[idx];
          ctx.beginPath();
          ctx.arc(pt.x * canvas.width, pt.y * canvas.height, 3, 0, 2 * Math.PI);
          ctx.fillStyle = '#00ffff';
          ctx.fill();
        });

        const ratio = calculateRatio(lm);
        if (ratio !== null) {
          evaluateGaze(ratio);
        } else {
          resetSelection();
        }
      } else {
        setFaceDetected(false);
        resetSelection();
      }
      ctx.restore();
    });

    let camera = null;
    if (videoRef.current) {
      camera = new CameraClass(videoRef.current, {
        onFrame: async () => {
          if (videoRef.current) {
            await faceMesh.send({ image: videoRef.current });
          }
        },
        width: 640,
        height: 480
      });
      camera.start().catch((err) => console.error(err));
    }

    return () => {
      if (camera) camera.stop();
      faceMesh.close();
    };
  }, [evaluateGaze]);

  // Calibración pasiva asistida (2 segundos mirando al centro)
  const handleCalibrate = () => {
    setIsCalibrating(true);
    setStatusMsg('Registrando centro...');
    const samples = [];

    const interval = setInterval(() => {
      if (currentRatio) samples.push(currentRatio);
    }, 80);

    setTimeout(() => {
      clearInterval(interval);
      if (samples.length > 8) {
        const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
        const finalVal = parseFloat(avg.toFixed(3));
        neutralPointRef.current = finalVal;
        setNeutralPoint(finalVal);
        setStatusMsg('✓ Calibrado');
      } else {
        setStatusMsg('Error de detección');
      }
      setIsCalibrating(false);
    }, 1800);
  };

  // ¿El paciente está mirando a la zona de descanso?
  const isResting = faceDetected && neutralPoint !== null && activeZone === null;

  return (
    <div className="app-container">
      <video ref={videoRef} playsInline style={{ display: 'none' }} />

      {/* Zona Superior: SÍ */}
      <div 
        className={`zone zone-yes ${activeZone === 'UP' ? 'active' : ''}`}
        onClick={() => speak('Sí')}
      >
        <div className="zone-content">
          <ChevronUp className="zone-icon" strokeWidth={3.5} />
          <span className="zone-title">SÍ</span>
          <span className="zone-sub">Mirar Arriba</span>
        </div>
        <div className="progress-bar-bg">
          <div 
            className="progress-fill" 
            style={{ width: activeZone === 'UP' ? `${progress}%` : '0%' }}
          />
        </div>
      </div>

      {/* Barra Central con Diana de Descanso */}
      <div className="dock">
        
        {/* Izquierda: Vista previa de cámara y datos técnicos */}
        <div className="dock-left">
          <div className="preview-wrapper">
            <canvas ref={canvasRef} className="preview-canvas" width="160" height="110" />
          </div>

          <div className="status-badge">
            <span className={`status-led ${faceDetected && neutralPoint !== null ? 'ready' : ''}`} />
            <div>
              <div style={{ fontWeight: 600 }}>{statusMsg}</div>
              <small style={{ opacity: 0.85, fontFamily: 'monospace' }}>
                Ojo: <b>{currentRatio}</b> | Base: <b>{neutralPoint ?? '--'}</b>
              </small>
            </div>
          </div>
        </div>

        {/* CENTRO: DIANA VISUAL DE DESCANSO */}
        <div className={`resting-target-container ${isResting ? 'is-resting' : ''}`}>
          <div className="resting-target">
            <div className="resting-inner-dot" />
          </div>
          <span className="resting-label">
            {isResting ? 'Descansando' : 'Centro'}
          </span>
        </div>

        {/* Derecha: Controles para el acompañante */}
        <div className="dock-right">
          <div className="control-slider">
            <span>Esfuerzo: {sensitivity === 0.025 ? 'Leve' : sensitivity === 0.035 ? 'Medio' : 'Alto'}</span>
            <input 
              type="range" 
              min="0.020" 
              max="0.055" 
              step="0.005"
              value={sensitivity} 
              onChange={(e) => setSensitivity(parseFloat(e.target.value))} 
            />
          </div>

          <button 
            className="btn-action" 
            style={{ background: neutralPoint ? '#238636' : '#2563eb' }}
            onClick={handleCalibrate}
            disabled={isCalibrating || !faceDetected}
          >
            <RotateCcw size={16} className={isCalibrating ? 'spin' : ''} />
            {isCalibrating ? 'Guardando...' : 'Calibrar Centro'}
          </button>
        </div>

      </div>

      {/* Zona Inferior: NO */}
      <div 
        className={`zone zone-no ${activeZone === 'DOWN' ? 'active' : ''}`}
        onClick={() => speak('No')}
      >
        <div className="progress-bar-bg">
          <div 
            className="progress-fill" 
            style={{ width: activeZone === 'DOWN' ? `${progress}%` : '0%' }}
          />
        </div>
        <div className="zone-content">
          <span className="zone-title">NO</span>
          <span className="zone-sub">Mirar Abajo</span>
          <ChevronDown className="zone-icon" strokeWidth={3.5} />
        </div>
      </div>
    </div>
  );
}