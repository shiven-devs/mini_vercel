import { login } from "../actions";
import { AuthForm } from "../auth-form";

export default function LoginPage() {
  return <AuthForm mode="login" action={login} />;
}
