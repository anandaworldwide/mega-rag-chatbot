import Head from "next/head";
import Image from "next/image";
import { SiteConfig } from "@/types/siteConfig";
import { getSiteName } from "@/utils/client/siteConfig";

interface AuthLayoutProps {
  siteConfig: SiteConfig | null;
  title?: string;
  children: React.ReactNode;
  belowCard?: React.ReactNode;
  priorityImage?: boolean;
}

export default function AuthLayout({ siteConfig, title, children, belowCard, priorityImage = false }: AuthLayoutProps) {
  const siteName = getSiteName(siteConfig);
  const pageTitle = title ? `${title} - ${siteName}` : siteName;

  return (
    <>
      <Head>
        <title>{pageTitle}</title>
      </Head>
      <div className="flex flex-col items-center justify-center min-h-screen px-4 py-8 bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 lg:bg-gradient-to-br lg:from-[#f8f9ff] lg:via-white lg:to-white">
        <div className="w-full flex flex-col items-center lg:max-w-6xl lg:flex-row lg:items-center lg:justify-center lg:gap-12">
          {siteConfig?.loginImage && (
            <div className="hidden lg:flex lg:flex-1 lg:items-center lg:justify-center">
              <div className="relative w-full max-w-[520px]">
                <Image
                  src={`/${siteConfig.loginImage}`}
                  alt={`${siteName} Logo`}
                  width={640}
                  height={640}
                  className="w-full h-auto object-contain drop-shadow-2xl"
                  priority={priorityImage}
                />
              </div>
            </div>
          )}
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full lg:max-w-md lg:flex-1 border border-gray-100 transform transition-all duration-300 hover:shadow-2xl overflow-hidden">
            {siteConfig?.loginImage && (
              <div className="flex flex-col items-center pt-8 px-8 pb-4 lg:hidden">
                <div className="relative" style={{ width: "100%", height: "auto" }}>
                  <Image
                    src={`/${siteConfig.loginImage}`}
                    alt={`${siteName} Logo`}
                    width={320}
                    height={320}
                    className="w-full h-auto object-contain drop-shadow-lg"
                  />
                </div>
              </div>
            )}
            {children}
          </div>
        </div>
        {belowCard && <div className="w-full flex flex-col items-center">{belowCard}</div>}
      </div>
    </>
  );
}
