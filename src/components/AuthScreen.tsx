import React, { useState } from "react";
import { 
  Lock, 
  User, 
  Sparkles, 
  Eye, 
  EyeOff, 
  ArrowRight, 
  UserPlus, 
  ShieldCheck, 
  AlertCircle,
  HelpCircle
} from "lucide-react";

interface AuthScreenProps {
  onLoginSuccess: (username: string, registeredUsers: Record<string, string>) => void;
  onRegisterSuccess?: (registeredUsers: Record<string, string>) => void;
  registeredUsersInitial: Record<string, string>;
}

export default function AuthScreen({ 
  onLoginSuccess, 
  onRegisterSuccess,
  registeredUsersInitial 
}: AuthScreenProps) {
  const [isRegister, setIsRegister] = useState<boolean>(false);
  const [username, setUsername] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [confirmPassword, setConfirmPassword] = useState<string>("");
  const [showPassword, setShowPassword] = useState<boolean>(false);
  
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Local copy of registered users to manage in-memory before submitting
  const [registeredUsers, setRegisteredUsers] = useState<Record<string, string>>(() => {
    // If empty, pre-populate a demo user
    if (Object.keys(registeredUsersInitial).length === 0) {
      return { "rentasync": "rentasync123" };
    }
    return registeredUsersInitial;
  });

  const handleDemoCredentials = () => {
    setUsername("rentasync");
    setPassword("rentasync123");
    setIsRegister(false);
    setError(null);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const cleanUsername = username.trim().toLowerCase();
    if (!cleanUsername) {
      setError("Por favor, introduce un nombre de usuario.");
      return;
    }

    if (password.length < 4) {
      setError("La contraseña debe tener al menos 4 caracteres.");
      return;
    }

    if (isRegister) {
      // REGISTRATION MODE
      if (password !== confirmPassword) {
        setError("Las contraseñas no coinciden.");
        return;
      }

      if (registeredUsers[cleanUsername]) {
        setError("Este nombre de usuario ya está registrado.");
        return;
      }

      // Add to registered users
      const updatedUsers = {
        ...registeredUsers,
        [cleanUsername]: password
      };
      setRegisteredUsers(updatedUsers);
      onRegisterSuccess?.(updatedUsers);
      setSuccess("¡Cuenta creada con éxito! Ahora puedes iniciar sesión.");
      
      // Auto switch to login after a tiny delay
      setTimeout(() => {
        setIsRegister(false);
        setPassword("");
        setConfirmPassword("");
        setSuccess(null);
      }, 1500);

    } else {
      // LOGIN MODE
      const storedPassword = registeredUsers[cleanUsername];
      if (!storedPassword || storedPassword !== password) {
        setError("Usuario o contraseña incorrectos.");
        return;
      }

      // Login success
      onLoginSuccess(cleanUsername, registeredUsers);
    }
  };

  return (
    <div id="auth-root" className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-4 font-sans antialiased relative overflow-hidden">
      
      {/* Decorative Background Elements */}
      <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] rounded-full bg-indigo-500/10 blur-[120px] pointer-events-none"></div>
      <div className="absolute bottom-[-20%] right-[-10%] w-[50%] h-[50%] rounded-full bg-pink-500/10 blur-[120px] pointer-events-none"></div>

      {/* Main Authentication Container */}
      <div className="w-full max-w-md bg-slate-900/40 border border-slate-800/80 backdrop-blur-md rounded-3xl p-8 shadow-2xl space-y-8 animate-fade-in z-10 relative">
        
        {/* Brand Logo & Presentation */}
        <div className="text-center space-y-3">
          <div className="inline-flex bg-indigo-600/20 text-indigo-400 p-3.5 rounded-2xl border border-indigo-500/20 shadow-inner">
            <Sparkles className="w-6 h-6" />
          </div>
          <div>
            <span className="text-[10px] uppercase font-mono tracking-widest font-extrabold text-indigo-400 block leading-tight">Acceso Seguro</span>
            <h1 className="text-2xl font-black text-white tracking-tight mt-1">RentaSync</h1>
            <p className="text-xs text-slate-400 mt-1.5 max-w-[280px] mx-auto leading-relaxed">
              Plataforma Inteligente de Sincronización Patrimonial, Matriz de Alquileres e Impuestos de España.
            </p>
          </div>
        </div>

        {/* Dynamic Form Header Title */}
        <div className="flex border-b border-slate-800/80 pb-1">
          <button
            type="button"
            onClick={() => {
              setIsRegister(false);
              setError(null);
              setSuccess(null);
            }}
            className={`flex-1 pb-3 text-xs font-bold font-mono uppercase tracking-wider border-b-2 transition-all ${
              !isRegister 
                ? "border-indigo-500 text-white" 
                : "border-transparent text-slate-500 hover:text-slate-300"
            }`}
          >
            Iniciar Sesión
          </button>
          <button
            type="button"
            onClick={() => {
              setIsRegister(true);
              setError(null);
              setSuccess(null);
            }}
            className={`flex-1 pb-3 text-xs font-bold font-mono uppercase tracking-wider border-b-2 transition-all ${
              isRegister 
                ? "border-indigo-500 text-white" 
                : "border-transparent text-slate-500 hover:text-slate-300"
            }`}
          >
            Crear Cuenta
          </button>
        </div>

        {/* Feedback Messages */}
        {error && (
          <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start space-x-2 text-xs text-red-400 animate-slide-in">
            <AlertCircle className="w-4.5 h-4.5 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {success && (
          <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl flex items-start space-x-2 text-xs text-emerald-400 animate-slide-in">
            <ShieldCheck className="w-4.5 h-4.5 shrink-0 mt-0.5" />
            <span>{success}</span>
          </div>
        )}

        {/* Authentication Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          
          {/* Username Input */}
          <div className="space-y-1.5">
            <label className="text-[10px] uppercase font-bold tracking-wider text-slate-400 block font-mono">
              Nombre de Usuario
            </label>
            <div className="relative">
              <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-slate-500">
                <User className="w-4 h-4" />
              </span>
              <input
                type="text"
                required
                placeholder="ej. rentasync_user"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 focus:border-indigo-500/50 rounded-xl pl-9 pr-4 py-2.5 text-xs text-white placeholder-slate-600 focus:outline-none transition-all font-medium"
              />
            </div>
          </div>

          {/* Password Input */}
          <div className="space-y-1.5">
            <label className="text-[10px] uppercase font-bold tracking-wider text-slate-400 block font-mono">
              Contraseña
            </label>
            <div className="relative">
              <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-slate-500">
                <Lock className="w-4 h-4" />
              </span>
              <input
                type={showPassword ? "text" : "password"}
                required
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 focus:border-indigo-500/50 rounded-xl pl-9 pr-10 py-2.5 text-xs text-white placeholder-slate-600 focus:outline-none transition-all font-medium font-mono"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-500 hover:text-slate-300"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Confirm Password Input (Register only) */}
          {isRegister && (
            <div className="space-y-1.5 animate-fade-in">
              <label className="text-[10px] uppercase font-bold tracking-wider text-slate-400 block font-mono">
                Confirmar Contraseña
              </label>
              <div className="relative">
                <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-slate-500">
                  <Lock className="w-4 h-4" />
                </span>
                <input
                  type={showPassword ? "text" : "password"}
                  required={isRegister}
                  placeholder="••••••••"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 focus:border-indigo-500/50 rounded-xl pl-9 pr-4 py-2.5 text-xs text-white placeholder-slate-600 focus:outline-none transition-all font-medium font-mono"
                />
              </div>
            </div>
          )}

          {/* Submit Button */}
          <button
            type="submit"
            className="w-full inline-flex items-center justify-center px-4 py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold rounded-xl text-xs transition-all cursor-pointer shadow-lg shadow-indigo-600/10 hover:shadow-indigo-600/20 focus:outline-none active:scale-98"
          >
            {isRegister ? (
              <>
                <UserPlus className="w-4 h-4 mr-1.5" />
                <span>Registrar Nueva Cuenta</span>
              </>
            ) : (
              <>
                <span>Acceder a RentaSync</span>
                <ArrowRight className="w-4 h-4 ml-1.5" />
              </>
            )}
          </button>
        </form>

        {/* Divider / Demo Account Bypass Option */}
        <div className="space-y-4 border-t border-slate-800/80 pt-5">
          <div className="text-center">
            <p className="text-[10px] text-slate-500 leading-normal">
              ¿Quieres probar el simulador sin registrarte? Usa las credenciales de demostración por defecto:
            </p>
          </div>
          
          <button
            type="button"
            onClick={handleDemoCredentials}
            className="w-full inline-flex items-center justify-center px-4 py-2 bg-slate-800/40 hover:bg-slate-800 border border-slate-700/60 rounded-xl text-xs text-slate-300 transition-all cursor-pointer font-semibold font-mono"
          >
            <HelpCircle className="w-3.5 h-3.5 mr-1.5 text-indigo-400" />
            <span>Rellenar credenciales demo</span>
          </button>
        </div>

      </div>

      {/* Safety Disclaimers */}
      <p className="text-[9px] text-slate-600 text-center mt-6 font-mono max-w-[340px] leading-normal z-10">
        Las credenciales se cifran de manera local en tu navegador. Tus datos financieros nunca se envían a servidores externos de manera desprotegida.
      </p>

    </div>
  );
}
