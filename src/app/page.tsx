import { redirect } from "next/navigation";

// Bu sayfa sadece /stores'a yönlendirir; statik shell/instant doğrulaması gerekmez.
export const instant = false;

export default function Home() {
  redirect("/stores");
}
